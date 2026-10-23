# Registro EJEC 2026

App mínima para marcar la llegada de servidores y vivientes al retiro.

## Configuración

Crea `.env`:

```
MONGODB_URI=mongodb+srv://usuario:clave@cluster.xxxxx.mongodb.net
DB_NAME=ejec
ADMIN_PASSWORD=una-clave
PORT=3000
```

## Uso

```bash
npm install
npm run import      # lee el .xlsx de data/ (data/EJEC_2026.xlsx o el primero que haya)
npm start           # http://localhost:3000
```

Para usar otro archivo: `npm run import -- ruta/archivo.xlsx`.

La importación se puede repetir sin peligro: hace upsert por nombre y solo rellena campos vacíos,
así que no borra llegadas, buses ni cuartos editados en la app.

## API (header `x-admin-password`)

- `GET /api/personas?tipo=&zona=&llego=&q=`
- `PATCH /api/personas/:id` — `llego`, `bus`, `cuarto`, `notas`
- `GET /api/resumen`
- `GET /api/zonas`
- `GET /api/export/faltan.csv`

## Despliegue en Render

1. Sube el repo a GitHub (sin `.env` ni `data/`).
2. Render → New → Web Service → conecta el repo.
3. Build: `npm install` · Start: `npm start`.
4. Environment: `MONGODB_URI`, `DB_NAME`, `ADMIN_PASSWORD` (Render define `PORT` solo).
5. En Atlas → Network Access, permite las IPs de salida de Render (o `0.0.0.0/0`).
6. Ejecuta `npm run import` desde tu PC (apunta a la misma base de datos).
