# 🗺️ Wikimapia Semantic Search & RAG Engine

[![License: MIT](https://img.shields.io/badge/Code_License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Data License: CC BY-NC-SA 3.0](https://img.shields.io/badge/Data_License-CC_BY--NC--SA_3.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc-sa/3.0/)

An intelligent spatial search engine and RAG pipeline for **Wikimapia** places and user comments. It enables natural language semantic search across crowdsourced local insights, historical notes, and place reviews.

Includes a web UI, a hybrid spatial/vector search engine (PostGIS + pgvector), and a native **MCP server** for LLM clients (Claude Desktop, Cursor).

---

## 🏗️ Architecture

* **Frontend:** Next.js, Tailwind CSS, Leaflet.js
* **Backend:** Node.js (TypeScript) / Python (FastAPI)
* **Database:** PostgreSQL 16 + PostGIS + pgvector
* **AI & Protocol:** Claude Haiku (intent parsing), Voyage AI embeddings, Model Context Protocol (MCP)

---

## 🛠️ Quick Start

### 1. Clone & Environment Setup
```bash
git clone https://github.com/your-username/wikimapia-semantic-search.git
cd wikimapia-semantic-search
cp .env.example .env
```

### 2. Start Database
```bash
docker-compose up -d postgres
```

### 3. Run Migrations & Import Dump
```bash
npm run db:migrate
python scripts/import_dump.py --region=belgrade
```

### 4. Start Web API & MCP Server
```bash
npm run dev
npm run start:mcp
```

---

## 📄 Licensing

* **Source Code:** Released under the [MIT License](LICENSE).
* **Data & Content:** All Wikimapia data is licensed under [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/). Commercial usage of the dataset is prohibited without permission from Wikimapia.
