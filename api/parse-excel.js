export const config = { maxDuration: 30 }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { headers, sampleRows } = req.body || {}
  if (!headers || !sampleRows) return res.status(400).json({ error: 'Missing headers or sampleRows' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' })

  const prompt = `Du bist ein Experte für Amazon Vine ITIM-Reports.
Ich habe eine Excel-Datei mit diesen Spalten: ${JSON.stringify(headers)}

Beispiel-Daten (erste Zeilen):
${JSON.stringify(sampleRows, null, 2)}

Identifiziere welche Spalte welchem Feld entspricht und antworte NUR mit einem JSON-Objekt:
{
  "bestellnummer": "exakter Spaltenname für Bestellnummer/Order Number/Order ID",
  "asin": "exakter Spaltenname für ASIN",
  "produkt": "exakter Spaltenname für Produktname",
  "etv": "exakter Spaltenname für ETV/Preis/Consideration Amount",
  "order_type": "exakter Spaltenname für Bestelltyp (oder null wenn nicht vorhanden)",
  "bestelldatum": "exakter Spaltenname für Bestelldatum (oder null)",
  "versanddatum": "exakter Spaltenname für Versanddatum/Shipped Date (oder null)",
  "storno_datum": "exakter Spaltenname für Stornodatum/Cancelled Date (oder null)"
}

Nur valides JSON, kein Text davor oder danach.`

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
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      return res.status(500).json({ error: 'Claude API Fehler: ' + err })
    }

    const data = await response.json()
    const text = data.content?.[0]?.text || ''

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return res.status(500).json({ error: 'Kein JSON in Antwort: ' + text.slice(0, 300) })

    const mapping = JSON.parse(jsonMatch[0])
    return res.status(200).json({ mapping })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
