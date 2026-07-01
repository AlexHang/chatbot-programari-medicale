function fallbackExtract(message) {
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

async function extractMedicalRecord(message) {
  const apiKey = process.env.OPENAI_API_KEY

  if (!apiKey) {
    return fallbackExtract(message)
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'Extrage doar campurile medicale relevante pentru o fisa medicala initiala. Raspunde strict JSON cu cheile symptoms, allergies, medication, chronicConditions, visitReason.',
          },
          {
            role: 'user',
            content: message,
          },
        ],
      }),
    })

    if (!response.ok) {
      return fallbackExtract(message)
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content

    if (!content) {
      return fallbackExtract(message)
    }

    const parsed = JSON.parse(content)
    return {
      symptoms: parsed.symptoms || [],
      allergies: parsed.allergies || [],
      medication: parsed.medication || [],
      chronicConditions: parsed.chronicConditions || [],
      visitReason: parsed.visitReason || '',
    }
  } catch {
    return fallbackExtract(message)
  }
}

module.exports = {
  extractMedicalRecord,
  fallbackExtract,
}
