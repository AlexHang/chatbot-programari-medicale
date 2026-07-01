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

    if (/programar|consultati|appointment/i.test(message) && /(urm|next|viitoare|cand)/i.test(message)) {
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

    if (/reprogram|muta|schimba/i.test(message)) {
      const appointments = this.schedulingService.listUpcomingAppointments(session.patientCode)
      const firstAppointment = appointments[0]
      const targetDate = message.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/)

      if (firstAppointment && targetDate) {
        const updated = await this.schedulingService.rescheduleAppointment({
          patientCode: session.patientCode,
          appointmentId: firstAppointment.id,
          startsAt: `${targetDate[1]}T${targetDate[2]}:00.000Z`,
        })

        return {
          appointment: updated,
          medicalRecord: session.medicalRecord,
          reply: `Am reprogramat consultatia pentru ${new Date(updated.startsAt).toLocaleString('ro-RO')}.`,
        }
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

module.exports = {
  ChatService,
  buildRomanianSummary,
  mergeMedicalRecord,
  validateBasicData,
}
