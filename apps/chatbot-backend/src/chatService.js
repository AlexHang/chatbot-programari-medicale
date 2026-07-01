const { randomUUID } = require('node:crypto')

class ChatService {
  constructor({ schedulingService }) {
    this.schedulingService = schedulingService
    this.sessions = new Map()
  }

  startSession(payload) {
    const patient = payload.patientCode
      ? this.schedulingService.findPatientByCode(payload.patientCode)
      : this.schedulingService.createPatient(validateBasicData(payload))

    if (!patient) {
      throw new Error('Patient not found')
    }

    const session = {
      id: randomUUID(),
      patientCode: patient.patientCode,
      medicalRecord: patient.medicalRecord || {},
      conversationHistory: [],
    }

    this.sessions.set(session.id, session)

    return {
      sessionId: session.id,
      patient,
      medicalRecord: session.medicalRecord,
      reply: payload.patientCode
        ? `Buna, ${patient.firstName}. Te-am identificat dupa codul ${patient.patientCode}. Cum te pot ajuta astazi?`
        : `Buna, ${patient.firstName}. Ti-am creat fisa initiala si codul ${patient.patientCode}. Cum te pot ajuta?`,
    }
  }

  async handleMessage({ sessionId, message }) {
    const session = this.sessions.get(sessionId)

    if (!session) {
      throw new Error('Session not found')
    }

    // Add user message to history
    session.conversationHistory.push({ role: 'user', content: message })

    // Get upcoming appointments for context
    const appointments = this.schedulingService.listUpcomingAppointments(session.patientCode)

    // Check if message contains a date - if so, get available slots for that date
    let availableSlotsContext = ''
    const dateMatch = extractDateFromMessage(message)
    if (dateMatch) {
      const availableSlots = this.schedulingService.getAvailableSlots(dateMatch)
      if (availableSlots.length > 0) {
        availableSlotsContext = `\n\nOre disponibile pentru ${dateMatch}: ${availableSlots.slice(0, 8).join(', ')} (și altele disponibile)`
      } else {
        availableSlotsContext = `\n\nNu sunt ore disponibile pentru ${dateMatch}.`
      }
    }

    // Try LLM first, fall back to rule-based if API key missing
    const hasApiKey = !!process.env.OPENAI_API_KEY
    let llmResult

    if (hasApiKey) {
      llmResult = await this.callLLMWithContextAwareness(message, session, appointments, availableSlotsContext)
    } else {
      llmResult = await this.callRuleBasedFallback(message, session, appointments)
    }

    // Add assistant response to history
    session.conversationHistory.push({ role: 'assistant', content: llmResult.reply })

    // Handle any structured actions (appointments, medical records)
    if (llmResult.action === 'schedule_appointment' && llmResult.appointmentData) {
      return this.scheduleAppointmentFromData(session, llmResult.appointmentData, llmResult.reply)
    }

    if (llmResult.action === 'reschedule_appointment' && llmResult.appointmentData) {
      return this.rescheduleAppointmentFromData(session, appointments, llmResult.appointmentData, llmResult.reply)
    }

    if (llmResult.action === 'list_appointments') {
      return {
        appointments,
        medicalRecord: session.medicalRecord,
        reply: llmResult.reply,
      }
    }

    if (llmResult.medicalUpdates) {
      session.medicalRecord = mergeMedicalRecord(session.medicalRecord, llmResult.medicalUpdates)
      this.schedulingService.updateMedicalRecord(session.patientCode, session.medicalRecord)
    }

    return {
      appointments,
      medicalRecord: session.medicalRecord,
      reply: llmResult.reply,
    }
  }

  async callRuleBasedFallback(message, session, appointments) {
    const normalizedMessage = normalizeText(message)

    // Check for upcoming appointments question
    if (isUpcomingAppointmentsQuestion(normalizedMessage)) {
      const reply =
        appointments.length > 0
          ? `Urmatoarele programari sunt: ${appointments
              .map((appointment) => `${appointment.reason} pe ${new Date(appointment.startsAt).toLocaleString('ro-RO')}`)
              .join('; ')}`
          : 'Nu ai programari viitoare.'

      return {
        action: 'list_appointments',
        reply,
      }
    }

    // Check for emergency
    if (detectEmergency(message)) {
      return {
        reply: `⚠️ Aceasta pare o situatie de urgenta. Te rog sa suni IMEDIAT la 112 sau sa te prezinti la Urgente. Nu iti pot oferi asistenta medicala.`,
      }
    }

    // Check for reschedule intent
    if (isRescheduleIntent(normalizedMessage)) {
      const targetDate = message.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/)
      if (appointments[0] && targetDate) {
        return {
          action: 'reschedule_appointment',
          appointmentData: {
            date: targetDate[1],
            time: targetDate[2],
          },
          reply: `Am inteles. Reprogramez pentru ${targetDate[1]} la ${targetDate[2]}.`,
        }
      }
      return {
        reply: `Bine. Care este noua data pentru programare? (exemplu: 2026-07-14 14:00)`,
      }
    }

    // Check for health complaint
    const healthComplaint = detectHealthComplaint(message, normalizedMessage)
    if (healthComplaint) {
      return {
        reply: `Inteleg ca ai ${healthComplaint.description}. Te-ai putea programa pentru o consultatie cu ${healthComplaint.specialty}. Iti deschid o programare?`,
        appointmentData: {
          specialty: healthComplaint.specialty,
        },
      }
    }

    // Check for schedule intent
    if (isScheduleIntent(normalizedMessage)) {
      return {
        action: 'schedule_appointment',
        reply: `Excelent! Ce data doresti? Exemplu: 2026-07-14, 14.07.2026, 14.07, 14, sau marti viitoare.`,
        appointmentData: {},
      }
    }

    // Extract medical info from message
    const extracted = await extractMedicalRecordFallback(message)
    if (extracted.symptoms?.length || extracted.allergies?.length || extracted.medication?.length) {
      const merged = mergeMedicalRecord(session.medicalRecord, extracted)
      session.medicalRecord = merged
      this.schedulingService.updateMedicalRecord(session.patientCode, merged)

      const summary = buildRomanianSummary(merged)
      return {
        reply: summary,
        medicalUpdates: extracted,
      }
    }

    // Default response
    return {
      reply: 'Poti sa-mi spui simptomele, daca vrei sa te programezi sau daca ai alte intrebari.',
    }
  }

  async callLLMWithContextAwareness(message, session, appointments, availableSlotsContext = '') {
    const apiKey = process.env.OPENAI_API_KEY

    if (!apiKey) {
      return await this.callRuleBasedFallback(message, session, appointments)
    }

    const systemPrompt = this.buildSystemPrompt(session, appointments, availableSlotsContext)
    const messages = [
      { role: 'system', content: systemPrompt },
      ...session.conversationHistory.slice(-20), // Keep last 20 messages for context
    ]

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-4-mini',
          temperature: 0.7,
          response_format: { type: 'json_object' },
          messages,
        }),
      })

      if (!response.ok) {
        console.error('LLM API error:', response.status)
        return await this.callRuleBasedFallback(message, session, appointments)
      }

      const data = await response.json()
      const content = data.choices?.[0]?.message?.content

      if (!content) {
        return await this.callRuleBasedFallback(message, session, appointments)
      }

      return JSON.parse(content)
    } catch (error) {
      console.error('LLM error:', error)
      return await this.callRuleBasedFallback(message, session, appointments)
    }
  }

  buildSystemPrompt(session, appointments, availableSlotsContext = '') {
    const medicalSummary = this.formatMedicalRecord(session.medicalRecord)
    const appointmentsSummary =
      appointments.length > 0
        ? `Pacientul are urmatoarele programari viitoare:\n${appointments.map((a) => `- ${a.reason} pe ${new Date(a.startsAt).toLocaleString('ro-RO')}`).join('\n')}`
        : 'Pacientul nu are programari viitoare.'

    return `Tu esti un asistent medical chatbot compasiv si util. Vorbesti DOAR in limba romana. Ghidezi pacientii prin:
1. Ascultarea cu atentie a simptomelor lor
2. Colectarea informatiilor medicale relevante (simptome, alergii, medicamente, istoric)
3. Detectarea situatiilor de urgenta (durere in piept, greu sa respiri, sangerare severa, etc.) si redirectionarea la 112
4. Sugestionarea specialistilor medicali relevanti in functie de simptome
5. Ajutarea cu programari la medici - VERIFICA DISPONIBILITATEA REALA si confirma cu detalii exacte

Esti empatic si natural, ca ChatGPT, nu rigid sau robotic. Raspunde intotdeauna in limba romana.

IMPORTANT: Raspunde INTOTDEAUNA cu JSON valid in acest format:
{
  "reply": "Raspunsul tau conversational aqui, in limba romana",
  "action": null or "schedule_appointment" or "reschedule_appointment" or "list_appointments",
  "appointmentData": null or { "date": "YYYY-MM-DD", "time": "HH:MM", "specialty": "speciality_name" },
  "medicalUpdates": null or { "symptoms": [], "allergies": [], "medication": [], "chronicConditions": [], "visitReason": "" }
}

Detalii pacient:
- Cod pacient: ${session.patientCode}
- Fisa medicala curenta: ${medicalSummary}
- Programari: ${appointmentsSummary}${availableSlotsContext}

IMPORTANT pentru programari:
- Cand utilizatorul cere o programare pentru o data specifica, verifica orele disponibile pe care ti le-am furnizat
- Sugereaza din orele disponibile oferite
- Cand utilizatorul alege o ora, confirma ca e disponibila si programeaza
- Pentru datele viitoare, sugerezi ore care par rezonabile (ex: dimineata 08:00-12:00, dupa-amiaza 14:00-17:00)
- Cand sunt colectate date + ora confirmata, seteaza "action": "schedule_appointment"

Cand utilizatorul mentioneaza vreo durere, simptom, sau motiv de consultatie, extrage informatiile medicale relevante si includle in "medicalUpdates".

Daca pacientul zice "nu" la o sugestie sau "nu stiu", nu fi stanjenitor - repeta intrebarea in mod natural.
Daca sunt semne de urgenta (durere in piept, rau de inima, greu sa respiri, sangerare severa, pierdut constiinta), intotdeauna raspunde cu urgenta si sfatuieste 112.`
  }

  formatMedicalRecord(record) {
    if (!record || Object.keys(record).length === 0) {
      return 'Nu au fost notate informatii medicale inca.'
    }

    const parts = []
    if (record.symptoms?.length) parts.push(`Simptome: ${record.symptoms.join(', ')}`)
    if (record.allergies?.length) parts.push(`Alergii: ${record.allergies.join(', ')}`)
    if (record.medication?.length) parts.push(`Medicamente: ${record.medication.join(', ')}`)
    if (record.chronicConditions?.length) parts.push(`Conditii cronice: ${record.chronicConditions.join(', ')}`)
    if (record.visitReason) parts.push(`Motiv: ${record.visitReason}`)

    return parts.join('; ')
  }

  scheduleAppointmentFromData(session, appointmentData, reply) {
    const date = appointmentData.date || ''
    const time = appointmentData.time || '10:00'
    const specialty = appointmentData.specialty || 'medicina interna'

    if (!date || date === 'YYYY-MM-DD') {
      return {
        medicalRecord: session.medicalRecord,
        reply: `Am inteles ca vrei o programare. Care este data preferata? (poti spune: maine, 2026-07-14, 14.07, etc.)`,
      }
    }

    const startsAt = `${date}T${time}:00.000`
    const appointment = this.schedulingService.scheduleAppointment({
      patientCode: session.patientCode,
      startsAt,
      reason: `Consultatie ${specialty}`,
      source: 'chatbot',
    })

    return {
      appointment,
      medicalRecord: session.medicalRecord,
      reply,
    }
  }

  rescheduleAppointmentFromData(session, appointments, appointmentData, reply) {
    if (appointments.length === 0) {
      return {
        medicalRecord: session.medicalRecord,
        reply: 'Nu ai nicio programare de reprogramat.',
      }
    }

    const date = appointmentData.date || ''
    const time = appointmentData.time || appointments[0].startsAt.split('T')[1]?.substring(0, 5) || '10:00'

    if (!date || date === 'YYYY-MM-DD') {
      return {
        medicalRecord: session.medicalRecord,
        reply: `Bine. Care este noua data pentru programare? (poti spune: maine, 2026-07-14, 14.07, etc.)`,
      }
    }

    const updated = this.schedulingService.rescheduleAppointment({
      patientCode: session.patientCode,
      appointmentId: appointments[0].id,
      startsAt: `${date}T${time}:00.000`,
    })

    return {
      appointment: updated,
      medicalRecord: session.medicalRecord,
      reply,
    }
  }
}


function validateBasicData(payload) {
  if (!payload.firstName || !payload.lastName || !payload.phone) {
    throw new Error('New patients must provide firstName, lastName and phone')
  }

  return {
    firstName: payload.firstName,
    lastName: payload.lastName,
    phone: payload.phone,
    email: payload.email || '',
    birthDate: payload.birthDate || '',
  }
}

function mergeMedicalRecord(current, next) {
  const mergeList = (key) => [...new Set([...(current[key] || []), ...(next[key] || [])])]

  return {
    symptoms: mergeList('symptoms'),
    allergies: mergeList('allergies'),
    medication: mergeList('medication'),
    chronicConditions: mergeList('chronicConditions'),
    visitReason: next.visitReason || current.visitReason || '',
  }
}

function buildRomanianSummary(record) {
  const segments = ['Am actualizat fisa medicala preliminara.']

  if (record.visitReason) {
    segments.push(`Motivul consultatiei: ${record.visitReason}.`)
  }

  if (record.symptoms?.length) {
    segments.push(`Simptome notate: ${record.symptoms.join(', ')}.`)
  }

  if (record.allergies?.length) {
    segments.push(`Alergii: ${record.allergies.join(', ')}.`)
  }

  if (record.medication?.length) {
    segments.push(`Tratament curent: ${record.medication.join(', ')}.`)
  }

  if (record.chronicConditions?.length) {
    segments.push(`Istoric medical relevant: ${record.chronicConditions.join(', ')}.`)
  }

  segments.push('Daca doresti, iti pot verifica si reprograma urmatoarea consultatie.')
  return segments.join(' ')
}

function normalizeText(message) {
  return message
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function extractMedicalRecordFallback(message) {
  const lowered = message.toLowerCase()
  const extractList = (pattern) => {
    const match = message.match(pattern)
    return match
      ? match[1]
          .split(/,| si /i)
          .map((value) => value.trim())
          .filter(Boolean)
      : []
  }

  const symptoms = extractList(/simptome(?:le)?(?: mele)?(?: sunt|:)?\s+([^.!?]+)/i)
  const allergies = extractList(/alergi(?:e|i)(?: la)?(?: sunt|:)?\s+([^.!?]+)/i)
  const medication = extractList(/tratament(?:ul)?(?: curent)?(?: este|:)?\s+([^.!?]+)/i)
  const chronicConditions = extractList(/istoric(?: medical)?(?: include|:)?\s+([^.!?]+)/i)
  const visitReasonMatch = message.match(/(?:motivul consultatiei|motivul vizitei)(?: este|:)?\s+([^.!?]+)/i)

  return {
    symptoms,
    allergies,
    medication,
    chronicConditions,
    visitReason: visitReasonMatch ? visitReasonMatch[1].trim() : lowered.includes('durere') ? message.trim() : '',
  }
}

function isUpcomingAppointmentsQuestion(message) {
  const hasAppointmentKeyword = /programar|consultat|appointment/.test(message)
  const hasQuestionSignal = /\bcand\b|\bcare\b|\bce\b|\burmator/.test(message)
  return hasAppointmentKeyword && hasQuestionSignal
}

function isRescheduleIntent(message) {
  return /reprogram|muta|schimba/.test(message)
}

function isScheduleIntent(message) {
  const hasAppointmentKeyword = /programar|consultat|appointment/.test(message)
  const hasScheduleVerb = /doresc|as dori|vreau|as vrea|programeaza|programez|rezerva|stabileste/.test(message)
  const looksLikeQuestion = /\bcand\b|\bcare\b|\bce\b/.test(message)

  return hasAppointmentKeyword && hasScheduleVerb && !looksLikeQuestion
}

function detectEmergency(message) {
  const emergencyKeywords = [
    'durere in piept',
    'greu sa respir',
    'inec',
    'inconsti',
    'sangerare',
    'paralize',
    'pierdut constin',
    'spital',
    'urgenta',
    'spital imediat',
    '112',
  ]

  const normalizedLower = message.toLowerCase()
  return emergencyKeywords.some((keyword) => normalizedLower.includes(keyword))
}

function detectHealthComplaint(message, normalizedMessage) {
  const complaintPatterns = [
    { keywords: ['durere|doare|dol', 'cap|creier|minte'], specialty: 'neurologie', description: 'dureri de cap' },
    {
      keywords: ['durere|doare', 'piept|inima|cord'],
      specialty: 'cardiologie',
      description: 'probleme cardiace',
    },
    {
      keywords: ['durere|doare|supar', 'stomac|burta|abdomen'],
      specialty: 'medicina interna',
      description: 'probleme digestive',
    },
    {
      keywords: ['mancare|inghetit|polip'],
      specialty: 'ORL',
      description: 'probleme din gat',
    },
    { keywords: ['piele|cosuri|mancarim'], specialty: 'dermatologie', description: 'probleme de piele' },
    {
      keywords: ['reumatism|artrita|durerile|cotul|genunchi'],
      specialty: 'ortopedie',
      description: 'probleme de oase/articulatii',
    },
    { keywords: ['tusea|tusei|rafala'], specialty: 'pneumologie', description: 'probleme respiratorii' },
    {
      keywords: ['anxieta|depresia|gandi|somn|psihic'],
      specialty: 'psihiatrie',
      description: 'probleme psihologice',
    },
  ]

  for (const pattern of complaintPatterns) {
    const hasComplaint = pattern.keywords.some((kw) => new RegExp(kw, 'i').test(message))
    if (hasComplaint) {
      return {
        specialty: pattern.specialty,
        description: pattern.description,
      }
    }
  }

  return null
}

function extractDateFromMessage(message) {
  const now = new Date()
  const currentYear = now.getFullYear()
  const currentMonth = now.getMonth() + 1

  // ISO format: YYYY-MM-DD
  const isoLike = message.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (isoLike) {
    return `${isoLike[1]}-${isoLike[2]}-${isoLike[3]}`
  }

  // Romanian format: DD.MM.YYYY
  const roFullLike = message.match(/\b(\d{2})\.(\d{2})\.(\d{4})\b/)
  if (roFullLike) {
    return `${roFullLike[3]}-${roFullLike[2]}-${roFullLike[1]}`
  }

  // Romanian format: DD.MM
  const roYearlessLike = message.match(/\b(\d{1,2})\.(\d{1,2})\b/)
  if (roYearlessLike) {
    const day = String(Number.parseInt(roYearlessLike[1], 10)).padStart(2, '0')
    const month = String(Number.parseInt(roYearlessLike[2], 10)).padStart(2, '0')
    return `${currentYear}-${month}-${day}`
  }

  // Weekday names
  const normalizedMessage = normalizeText(message)
  const weekdayMatch = normalizedMessage.match(
    /\b(luni|lunea|marti|martea|miercuri|miercurea|joi|joia|vineri|vinerea|sambata|duminica)(?:\s+viitoare)?\b/,
  )

  if (weekdayMatch) {
    const dayMap = {
      luni: 1,
      lunea: 1,
      marti: 2,
      martea: 2,
      miercuri: 3,
      miercurea: 3,
      joi: 4,
      joia: 4,
      vineri: 5,
      vinerea: 5,
      sambata: 6,
      duminica: 0,
    }

    const targetDay = dayMap[weekdayMatch[1]]
    const candidate = new Date(now)
    const daysUntil = (targetDay - now.getDay() + 7) % 7
    candidate.setDate(now.getDate() + (daysUntil === 0 ? 7 : daysUntil))

    const year = candidate.getFullYear()
    const month = String(candidate.getMonth() + 1).padStart(2, '0')
    const day = String(candidate.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  // "maine" (tomorrow)
  if (/\bmaine\b/.test(normalizedMessage)) {
    const tomorrow = new Date(now)
    tomorrow.setDate(now.getDate() + 1)
    const year = tomorrow.getFullYear()
    const month = String(tomorrow.getMonth() + 1).padStart(2, '0')
    const day = String(tomorrow.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  return null
}

module.exports = {
  ChatService,
  validateBasicData,
  mergeMedicalRecord,
}
