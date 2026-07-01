const { randomUUID } = require('node:crypto')

const { extractMedicalRecord } = require('./openAiExtractor')

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
      pendingAppointment: null,
      state: null,
    }

    this.sessions.set(session.id, session)

    return {
      sessionId: session.id,
      patient,
      medicalRecord: session.medicalRecord,
      reply: payload.patientCode
        ? `Buna, ${patient.firstName}. Te-am identificat dupa codul ${patient.patientCode}. Spune-mi pe scurt motivul consultatiei, simptomele, istoricul medical sau daca vrei sa verific programarile.`
        : `Buna, ${patient.firstName}. Ti-am creat fisa initiala si codul ${patient.patientCode}. Acum poti sa-mi spui simptomele, alergiile, tratamentele si motivul consultatiei.`,
    }
  }

  async handleMessage({ sessionId, message }) {
    const session = this.sessions.get(sessionId)

    if (!session) {
      throw new Error('Session not found')
    }

    const normalizedMessage = normalizeText(message)

    if (isUpcomingAppointmentsQuestion(normalizedMessage)) {
      const appointments = this.schedulingService.listUpcomingAppointments(session.patientCode)
      return {
        appointments,
        medicalRecord: session.medicalRecord,
        reply:
          appointments.length > 0
            ? `Urmatoarele programari sunt: ${appointments
                .map((appointment) => `${appointment.reason} pe ${new Date(appointment.startsAt).toLocaleString('ro-RO')}`)
                .join('; ')}`
            : 'Nu am gasit programari viitoare pentru acest pacient.',
      }
    }

    if (isRescheduleIntent(normalizedMessage)) {
      const appointments = this.schedulingService.listUpcomingAppointments(session.patientCode)
      const firstAppointment = appointments[0]
      const targetDate = message.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/)

      if (firstAppointment && targetDate) {
        const updated = await this.schedulingService.rescheduleAppointment({
          patientCode: session.patientCode,
          appointmentId: firstAppointment.id,
          startsAt: `${targetDate[1]}T${targetDate[2]}:00.000`,
        })

        return {
          appointment: updated,
          medicalRecord: session.medicalRecord,
          reply: `Am reprogramat consultatia pentru ${new Date(updated.startsAt).toLocaleString('ro-RO')}.`,
        }
      }
    }

    const emergencyCheck = detectEmergency(message)
    if (emergencyCheck) {
      return {
        medicalRecord: session.medicalRecord,
        reply: `⚠️ Aceasta pare o situatie de urgenta. Te rog sa suni IMEDIAT la 112 sau sa te prezinti la Urgente. Nu iti pot oferi asistenta medicala.`,
      }
    }

    const healthComplaint = detectHealthComplaint(message, normalizedMessage)
    if (healthComplaint && !isScheduleIntent(normalizedMessage)) {
      const suggestedSpecialty = healthComplaint.specialty
      const reply =
        `Inteleg ca ai ${healthComplaint.description}. Acest lucru pare sa se refere la ${suggestedSpecialty}. ` +
        `Te poti programa pentru o consultatie cu ${suggestedSpecialty}. Doresti sa fac aceasta programare?`

      session.pendingAppointment = {
        date: '',
        time: '',
        specialty: suggestedSpecialty,
      }
      session.state = 'awaiting_booking_confirmation'

      return {
        medicalRecord: session.medicalRecord,
        reply,
      }
    }

    if (isScheduleIntent(normalizedMessage)) {
      session.state = 'collecting_booking_details'
      if (!session.pendingAppointment) {
        session.pendingAppointment = {
          date: '',
          time: '',
          specialty: '',
        }
      }
      return {
        medicalRecord: session.medicalRecord,
        reply: `Excelent! Ce data doresti? Exemplu: 2026-07-14, 14.07.2026, 14.07, 14, sau marti viitoare.`,
      }
    }

    if (session.state === 'awaiting_booking_confirmation') {
      if (checkYesIntent(normalizedMessage)) {
        session.state = 'collecting_booking_details'
        return {
          medicalRecord: session.medicalRecord,
          reply: `Excelent! Ce data doresti? Exemplu: 2026-07-14, 14.07.2026, 14.07, 14, sau marti viitoare.`,
        }
      }
      if (checkNoIntent(normalizedMessage)) {
        session.pendingAppointment = null
        session.state = null
        return {
          medicalRecord: session.medicalRecord,
          reply: 'Inteleg. Poti sa-mi spui daca vrei sa iti verific alte programari sau daca ai alte intrebari.',
        }
      }
      return {
        medicalRecord: session.medicalRecord,
        reply: `Nu sunt sigur ca am inteles. Doresti sa te programezi cu ${session.pendingAppointment.specialty} (da/nu)?`,
      }
    }

    if (session.state === 'collecting_booking_details' && session.pendingAppointment) {
      const bookingReply = this.handleAppointmentBooking(session, message, normalizedMessage)
      if (bookingReply) {
        return bookingReply
      }
    }

    const extracted = await extractMedicalRecord(message)
    const mergedRecord = mergeMedicalRecord(session.medicalRecord, extracted)
    session.medicalRecord = mergedRecord
    this.schedulingService.updateMedicalRecord(session.patientCode, mergedRecord)

    return {
      medicalRecord: mergedRecord,
      reply: buildRomanianSummary(mergedRecord),
    }
  }

  handleAppointmentBooking(session, message, normalizedMessage) {
    if (!session.pendingAppointment) {
      session.pendingAppointment = {
        date: '',
        time: '',
        specialty: '',
      }
    }

    const details = extractAppointmentDetails(message, normalizedMessage)
    if (details.date) {
      session.pendingAppointment.date = details.date
    }
    if (details.time) {
      session.pendingAppointment.time = details.time
    }
    if (details.specialty && !session.pendingAppointment.specialty) {
      session.pendingAppointment.specialty = details.specialty
    }

    if (session.pendingAppointment.date && session.pendingAppointment.time && session.pendingAppointment.specialty) {
      const startsAt = `${session.pendingAppointment.date}T${session.pendingAppointment.time}:00.000`
      const specialtyLabel = toDisplaySpecialty(session.pendingAppointment.specialty)
      const appointment = this.schedulingService.scheduleAppointment({
        patientCode: session.patientCode,
        startsAt,
        reason: `Consultatie ${specialtyLabel}`,
        source: 'chatbot',
      })

      session.pendingAppointment = null
      session.state = null

      return {
        appointment,
        medicalRecord: session.medicalRecord,
        reply: `Te-am programat la ${specialtyLabel} pe ${formatDateForDisplay(startsAt)} la ${formatTimeForDisplay(startsAt)}.`,
      }
    }

    const hints = []
    if (session.pendingAppointment.date) {
      hints.push(`data: ${formatDateForDisplay(`${session.pendingAppointment.date}T00:00:00.000`)}`)  
    }
    if (session.pendingAppointment.time) {
      hints.push(`ora: ${session.pendingAppointment.time}`)
    }
    if (session.pendingAppointment.specialty) {
      hints.push(`specialitate: ${toDisplaySpecialty(session.pendingAppointment.specialty)}`)
    }

    let question = ''
    if (!session.pendingAppointment.date) {
      question = 'Ce data doresti? Exemplu: 2026-07-14, 14.07.2026, 14.07, 14, sau marti viitoare.'
    } else if (!session.pendingAppointment.time) {
      question = 'La ce ora doresti consultatia? Exemplu: 15:00 sau ora 15.'
    } else {
      question = 'La ce specialitate doresti consultatia? Exemplu: cardiologie.'
    }

    return {
      medicalRecord: session.medicalRecord,
      reply: hints.length > 0 ? `Am notat ${hints.join(', ')}. ${question}` : question,
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

function checkYesIntent(message) {
  return /\bda\b|ok|okay|perfect|excelent|sigur|glasul|agree|desigur|confirm|bine/.test(message)
}

function checkNoIntent(message) {
  return /\bnu\b|nope|nu vreau|nu doresc|nu as vrea|nu stiu/.test(message)
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

function extractAppointmentDetails(message, normalizedMessage) {
  return {
    date: parseFlexibleDate(message, normalizedMessage),
    time: parseTime(message),
    specialty: parseSpecialty(message, normalizedMessage),
  }
}

function parseFlexibleDate(message, normalizedMessage) {
  const now = new Date()
  const currentYear = now.getFullYear()
  const currentMonth = now.getMonth() + 1

  const isoLike = message.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (isoLike) {
    return `${isoLike[1]}-${isoLike[2]}-${isoLike[3]}`
  }

  const roFullLike = message.match(/\b(\d{2})\.(\d{2})\.(\d{4})\b/)
  if (roFullLike) {
    return `${roFullLike[3]}-${roFullLike[2]}-${roFullLike[1]}`
  }

  const roYearlessLike = message.match(/\b(\d{1,2})\.(\d{1,2})\b/)
  if (roYearlessLike) {
    const day = String(Number.parseInt(roYearlessLike[1], 10)).padStart(2, '0')
    const month = String(Number.parseInt(roYearlessLike[2], 10)).padStart(2, '0')
    return `${currentYear}-${month}-${day}`
  }

  const dayOnlyLike = message.match(/\bpe\s+(\d{1,2})\b|^(\d{1,2})(?:\s|$)/)
  if (dayOnlyLike) {
    const day = String(Number.parseInt(dayOnlyLike[1] || dayOnlyLike[2], 10)).padStart(2, '0')
    const month = String(currentMonth).padStart(2, '0')
    return `${currentYear}-${month}-${day}`
  }

  const weekdayMatch = normalizedMessage.match(
    /\b(luni|lunea|marti|martea|miercuri|miercurea|joi|joia|vineri|vinerea|sambata|duminica)(?:\s+viitoare)?\b/,
  )

  if (!weekdayMatch) {
    return ''
  }

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

function parseTime(message) {
  const hhmm = message.match(/\b(\d{1,2}):(\d{2})\b/)
  if (hhmm) {
    const hours = Number.parseInt(hhmm[1], 10)
    const minutes = Number.parseInt(hhmm[2], 10)
    if (Number.isNaN(hours) || Number.isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      return ''
    }
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
  }

  const shortHour = message.match(/(?:\bla\b|\bora\b)\s*(\d{1,2})\b/i)
  if (!shortHour) {
    return ''
  }

  const hours = Number.parseInt(shortHour[1], 10)
  if (Number.isNaN(hours) || hours < 0 || hours > 23) {
    return ''
  }

  return `${String(hours).padStart(2, '0')}:00`
}

function parseSpecialty(message, normalizedMessage) {
  const knownSpecialties = [
    'cardiologie',
    'dermatologie',
    'neurologie',
    'ortopedie',
    'pediatrie',
    'ginecologie',
    'orl',
    'medicina interna',
    'endocrinologie',
    'urologie',
    'psihiatrie',
  ]

  const known = knownSpecialties.find((specialty) => normalizedMessage.includes(specialty))
  if (known) {
    return known
  }

  const explicitSpecialty = message.match(/specialitate(?:a)?\s+([a-zA-Z\-\s]{3,40})/i)
  if (explicitSpecialty) {
    return explicitSpecialty[1].trim().toLowerCase()
  }

  const compactAnswer = normalizedMessage.trim()
  if (/^[a-z\s\-]{3,30}$/.test(compactAnswer) && !/programar|consultat|vreau|doresc|pot|cand|ora|data/.test(compactAnswer)) {
    return compactAnswer
  }

  return ''
}

function toDisplaySpecialty(specialty) {
  return specialty
    .split(' ')
    .filter(Boolean)
    .map((segment) => segment[0].toUpperCase() + segment.slice(1))
    .join(' ')
}

function formatDateForDisplay(isoDate) {
  const date = new Date(isoDate)
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const year = date.getFullYear()
  return `${day}.${month}.${year}`
}

function formatTimeForDisplay(isoDate) {
  const date = new Date(isoDate)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

function toDisplaySpecialty(specialty) {
  return specialty
    .split(' ')
    .filter(Boolean)
    .map((segment) => segment[0].toUpperCase() + segment.slice(1))
    .join(' ')
}

module.exports = {
  ChatService,
  buildRomanianSummary,
  mergeMedicalRecord,
  validateBasicData,
}
