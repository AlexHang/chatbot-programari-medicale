# chatbot-programari-medicale

Aplicatie modulara pentru un chatbot medical in limba romana, impartita in:

1. `modules/scheduling` - wrapper pentru pacienti, programari, calendar local si integrare Google Calendar
2. `apps/chatbot-backend` - API Node.js pentru intake medical, identificare prin cod pacient si administrare programari
3. `apps/frontend` - interfata React pentru initierea conversatiei si vizualizarea raspunsurilor
4. `modules/channel-connector` - conector extensibil pentru email, WhatsApp, Facebook si alte canale

## Flux principal

- doctorul poate crea un pacient nou si sistemul genereaza un cod unic
- pacientul poate incepe conversatia folosind codul sau date de baza
- chatbotul colecteaza simptome, alergii, tratamente si istoric medical intr-un rezumat de fisa medicala
- pacientul poate intreba despre urmatoarele programari si poate cere reprogramarea direct din chat
- programarile pot fi pastrate in baza interna si sincronizate ulterior cu Google Calendar sau alte API-uri medicale

## Structura

```text
apps/
  chatbot-backend/
  frontend/
modules/
  channel-connector/
  scheduling/
```

## Rulare

```bash
npm --prefix apps/chatbot-backend start
npm --prefix apps/frontend run dev
```

Frontend-ul foloseste implicit `http://localhost:3001` ca API. Se poate schimba prin `VITE_API_BASE_URL`.

## Configurare .env

Aplicatia accepta variabile din `.env` astfel:

1. backend (`apps/chatbot-backend`):
  - citeste `.env` din radacina repo-ului
  - citeste si `apps/chatbot-backend/.env` (acesta are prioritate)
2. frontend (`apps/frontend`):
  - Vite citeste automat `apps/frontend/.env`
  - doar variabilele prefixate cu `VITE_` sunt expuse in browser

Poti porni rapid de la fisierele exemplu: `.env.example`, `apps/chatbot-backend/.env.example`, `apps/frontend/.env.example`.

Exemple rapide:

```env
# apps/chatbot-backend/.env
PORT=3001
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
CORS_ORIGIN=http://localhost:5173
```

```env
# apps/frontend/.env
VITE_API_BASE_URL=http://localhost:3001
```

## Teste

```bash
npm test
```

## Endpoint-uri importante

- `POST /api/patients` - creeaza pacient si returneaza codul unic
- `POST /api/chat/session/start` - initiaza conversatia cu cod pacient sau date de baza
- `POST /api/chat/message` - continua conversatia si extrage date medicale
- `GET /api/patients/:patientCode/appointments` - listeaza programarile viitoare
- `POST /api/patients/:patientCode/appointments/reschedule` - reprogrameaza o programare
- `POST /api/channels/:channel/inbound` - normalizeaza mesaje din email/WhatsApp/Facebook/web
```
