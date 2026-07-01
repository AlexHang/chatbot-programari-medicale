import { useMemo, useState } from 'react'
import './App.css'

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001'

const emptyNewPatient = {
  firstName: '',
  lastName: '',
  phone: '',
  email: '',
  birthDate: '',
}

function App() {
  const [patientCode, setPatientCode] = useState('PAC-0001')
  const [newPatient, setNewPatient] = useState(emptyNewPatient)
  const [session, setSession] = useState(null)
  const [message, setMessage] = useState('')
  const [messages, setMessages] = useState([])
  const [error, setError] = useState('')

  const patientSummary = useMemo(() => {
    if (!session?.patient) {
      return null
    }

    const { patient } = session
    return `${patient.firstName} ${patient.lastName} • cod ${patient.patientCode}`
  }, [session])

  async function startWithCode(event) {
    event.preventDefault()
    await startSession({ patientCode })
  }

  async function startAsNewPatient(event) {
    event.preventDefault()
    await startSession(newPatient)
  }

  async function startSession(payload) {
    setError('')

    const response = await fetch(`${apiBaseUrl}/api/chat/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await response.json()

    if (!response.ok) {
      setError(data.error || 'Nu am putut porni conversatia.')
      return
    }

    setSession(data)
    setMessages([{ role: 'assistant', text: data.reply }])
  }

  async function sendMessage(event) {
    event.preventDefault()
    if (!message.trim() || !session?.sessionId) {
      return
    }

    setError('')
    const outgoing = message.trim()
    setMessages((current) => [...current, { role: 'user', text: outgoing }])
    setMessage('')

    const response = await fetch(`${apiBaseUrl}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.sessionId, message: outgoing }),
    })
    const data = await response.json()

    if (!response.ok) {
      setError(data.error || 'Mesajul nu a putut fi procesat.')
      return
    }

    setMessages((current) => [...current, { role: 'assistant', text: data.reply }])
    setSession((current) => ({ ...current, medicalRecord: data.medicalRecord || current.medicalRecord }))
  }

  return (
    <main className="layout">
      <section className="hero">
        <div>
          <p className="eyebrow">Chatbot medical in romana</p>
          <h1>Intake medical + programari intr-o arhitectura modulara</h1>
          <p className="lead">
            Backend-ul colecteaza date pentru fisa medicala, foloseste coduri unice pentru pacienti si poate lista sau reprograma consultatiile.
          </p>
        </div>
        <ul className="module-grid">
          <li><strong>Scheduling</strong><span>baza interna + Google Calendar</span></li>
          <li><strong>Chatbot API</strong><span>Node.js + intake in romana</span></li>
          <li><strong>React UI</strong><span>pregatita pentru alte front-end-uri</span></li>
          <li><strong>Connectors</strong><span>web, email, WhatsApp, Facebook</span></li>
        </ul>
      </section>

      <section className="panels">
        <form className="panel" onSubmit={startWithCode}>
          <h2>Pacient existent</h2>
          <p>Introdu codul primit de la cabinet pentru a continua discutia si pentru a verifica programarile.</p>
          <label>
            Cod pacient
            <input value={patientCode} onChange={(event) => setPatientCode(event.target.value)} />
          </label>
          <button type="submit">Porneste cu cod</button>
        </form>

        <form className="panel" onSubmit={startAsNewPatient}>
          <h2>Pacient nou</h2>
          <p>Colectam doar datele de baza la inceput, apoi chatbotul completeaza fisa medicala din conversatie.</p>
          <div className="two-columns">
            <label>
              Prenume
              <input value={newPatient.firstName} onChange={(event) => setNewPatient((current) => ({ ...current, firstName: event.target.value }))} />
            </label>
            <label>
              Nume
              <input value={newPatient.lastName} onChange={(event) => setNewPatient((current) => ({ ...current, lastName: event.target.value }))} />
            </label>
            <label>
              Telefon
              <input value={newPatient.phone} onChange={(event) => setNewPatient((current) => ({ ...current, phone: event.target.value }))} />
            </label>
            <label>
              Email
              <input value={newPatient.email} onChange={(event) => setNewPatient((current) => ({ ...current, email: event.target.value }))} />
            </label>
            <label>
              Data nasterii
              <input type="date" value={newPatient.birthDate} onChange={(event) => setNewPatient((current) => ({ ...current, birthDate: event.target.value }))} />
            </label>
          </div>
          <button type="submit">Creeaza pacient si chat</button>
        </form>
      </section>

      <section className="chat-shell">
        <div className="chat-header">
          <div>
            <h2>Conversatie</h2>
            <p>{patientSummary || 'Inca nu a fost pornita nicio sesiune.'}</p>
          </div>
          {session?.medicalRecord && (
            <div className="record-card">
              <strong>Rezumat fisa</strong>
              <span>Motiv: {session.medicalRecord.visitReason || 'necompletat'}</span>
              <span>Simptome: {(session.medicalRecord.symptoms || []).join(', ') || 'necompletat'}</span>
            </div>
          )}
        </div>

        <div className="messages">
          {messages.map((entry, index) => (
            <article key={`${entry.role}-${index}`} className={`message ${entry.role}`}>
              <strong>{entry.role === 'assistant' ? 'Chatbot' : 'Pacient'}</strong>
              <p>{entry.text}</p>
            </article>
          ))}
        </div>

        <form className="composer" onSubmit={sendMessage}>
          <textarea
            rows="4"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Ex: Motivul consultatiei este control anual. Simptomele sunt oboseala, ameteli. Sau: Cand sunt urmatoarele mele programari?"
          />
          <button type="submit">Trimite mesaj</button>
        </form>

        {error && <p className="error">{error}</p>}
      </section>
    </main>
  )
}

export default App
