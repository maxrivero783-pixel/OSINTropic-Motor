# OSINTropic-Motor

Motor de análisis documental para el ecosistema OSINTropic. Elimina los techos de
Cloudflare Workers (cron de 15 min, 50 subrequests del plan free) ejecutando la
cadena de modelos fuera del borde:

    gemini → openrouter → workers_ai

El worker `osintropic-infowar` recolecta y selecciona los documentos, despacha un
trabajo a este motor y recibe el resultado por callback; después compone el informe,
lo envía por email y lo retransmite al bot.

## Endpoints

| Método | Ruta              | Descripción                                        |
|--------|-------------------|----------------------------------------------------|
| GET    | `/salud`          | Estado del motor (health check de Render)          |
| POST   | `/trabajos`       | Encola un trabajo (header `X-Clave-Motor`)         |
| GET    | `/trabajos/{id}`  | Estado y resultado de un trabajo                   |

### Cuerpo de `POST /trabajos`

```json
{
  "trabajo_id": "rep_2026-10-29_0800",
  "docs": [
    { "id": "doc_1", "system": "prompt del sistema", "user": "texto del documento" }
  ],
  "cfg": {
    "orden": ["gemini", "openrouter", "workers_ai"],
    "modelos": {
      "gemini": ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
      "openrouter": ["nvidia/nemotron-3.5-lightning:free"],
      "workers_ai": ["@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/openai/gpt-oss-120b"]
    },
    "intento_ms": 90000,
    "salida_tokens": 2048,
    "conc": 4,
    "gemini_base": "https://generativelanguage.googleapis.com/v1beta",
    "cancelar_si_timeout": false
  },
  "creds": {
    "gemini_key": "...",
    "openrouter_keys": ["..."],
    "cf_token": "...",
    "cf_account": "..."
  },
  "callback": { "url": "https://.../informe/motor", "clave": "..." }
}
```

Las credenciales viajan por trabajo (HTTPS + clave compartida) y no se guardan en
el motor: no hay secrets en reposo.

## Despliegue en Render

1. Nuevo **Web Service** conectado a este repositorio.
2. Runtime: **Node**. Build: ninguno. Start: `node server.js`.
3. Health check path: `/salud`.
4. Variable de entorno: `CLAVE_MOTOR` (clave compartida con el worker).
5. Plan free: la instancia se duerme a los ~15 min sin tráfico y el primer
   despacho la despierta (30-60 s de arranque en frío); para el informe de las
   08:00 basta, o se activa *Always On* para eliminar el arranque en frío.

## Pruebas realizadas (2026-10-29, con modelos reales)

- 2 documentos vía gemini-3.5-flash-lite (AI Gateway): JSON válido, ~1,8 s/doc,
  severidad y temas correctos, callback entregado con clave.
- Cascada completa: gemini colgado (3.8-flash) → timeout a los 15 s → openrouter
  sin claves (salta) → workers_ai llama-4-scout por REST: OK en 2,3 s.
