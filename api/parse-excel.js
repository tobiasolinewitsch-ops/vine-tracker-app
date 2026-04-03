export const config = { maxDuration: 30 }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { rows } = req.body
  if (!rows || !rows.length) return res.status(400).json({ error: 'No rows provided' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' })

  // Ersten 3 Zeilen als Beispiel zeigen + alle Spaltenüberschriften
  const headers = Object.keys(rows[0] || {})
  const sampleRows = rows.slice(0, 3)

  const prompt = `Du bist ein Datenextraktor für Amazon Vine ITIM-Reports. Analysiere diese Excel-Daten und extrahiere strukturierte Artikel-Daten.

Spaltenüberschriften in der Datei: ${headers.join(', ')}

Beispiel-Zeilen (erste 3):
${JSON.stringify(sampleRows, null, 2)}

Alle Zeilen (${rows.length} Stück):
${JSON.stringify(rows, null, 2)}

Extrahiere für JEDE Zeile folgende Felder und gib ein JSON-Array zurück:
- bestellnummer: Bestellnummer / Order Number / Order ID
- asin: ASIN-Code (B0...)
- produkt: Produktname / Product Name
- etv: ETV / Consideration Amount als Zahl (Komma zu Punkt, nur Zahl)
- order_type: Order Type (ORDER, RETURN, etc.) - Standard: "ORDER"
- bestelldatum: Bestelldatum als YYYY-MM-DD oder null
- versanddatum: Versanddatum / Shipped Date als YYYY-MM-DD oder null
- storno_datum: Stornodatum / Cancelled Date als YYYY-MM-DD oder null

Regeln:
- Zeilen ohne ASIN oder Bestellnummer überspringen
- Kopfzeilen und leere Zeilen überspringen
- Datumsformat immer YYYY-MM-DD
- Zahlen ohne Währungssymbol, Punkt als Dezimaltrenner
- Nur valides JSON zurückgeben, kein Text drumherum

Antwort NUR als JSON-Array: [{"bestellnummer":"...","asin":"...","produkt":"...","etv":0.00,...}, ...]`

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      return res.status(500).json({ error: 'Claude API error: ' + err })
    }

    const data = await response.json()
    const text = data.content?.[0]?.text || ''

    // JSON aus Antwort extrahieren
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return res.status(500).json({ error: 'Kein JSON in Antwort: ' + text.slice(0, 200) })

    const items = JSON.parse(jsonMatch[0])
    return res.status(200).json({ items })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
