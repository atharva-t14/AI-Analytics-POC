## Running Locally

**Backend**

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env   # Add GROQ_API_KEY and DATABASE_URL
uvicorn app.main:app --reload --port 8000
```

**Frontend**

```bash
cd frontend
npm install
npm run dev            # Starts on http://localhost:3000
```

**Environment Variables**

| Variable | Description |
|----------|-------------|
| `GROQ_API_KEY` | Groq API key for LLM intent resolution |
| `DATABASE_URL` | SQLAlchemy MySQL connection string |
