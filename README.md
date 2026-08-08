# Sweeger Backend — Local Setup Guide

## Prerequisites
Make sure you have **Node.js** and **Git** installed on your machine before starting.

---

## Steps

### 1. Clone the repository
```bash
git clone https://github.com/Sweeger-inc/Sweeger-backend.git
```

### 2. Navigate into the project folder
```bash
cd Sweeger-backend
```

### 3. Install dependencies
```bash
npm install
```

### 4. Install nodemon globally (if you don't have it)
```bash
npm install -g nodemon
```
> If global install fails due to permissions, a local install works fine too — the project will still run.

### 5. Add the environment file
Check your email for the `.env` file I sent you. Copy it and paste it into the **root of the project folder** (same level as `package.json`). Do not rename it.

### 6. Start the server
```bash
npm run dev
```
> If that fails, try:
```bash
npm start
```

---

## Important
⚠️ **Do not modify any code in the project.** This is the backend codebase — your work is on the frontend only. If something isn't working, reach out and I'll look into it.

---

Once the server is running you should see:

🚀 Sweeger backend running on port 5000

That means everything is good. Point your frontend to `http://localhost:5000` instead of the Render URL and you're set.
