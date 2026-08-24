export default async function handler(req, res) {
  // Chỉ chấp nhận POST request
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  const GAS_ENDPOINT = "https://script.google.com/macros/s/AKfycbyVw9bJ5DN3FS-MaRZVsPXWj40ch2b3XDZG4O1Kqh8K41o7w3QIIyLlithOJLaVVZgJww/exec";

  try {
    const payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    const response = await fetch(GAS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: payload,
      redirect: 'follow'
    });

    const text = await response.text();
    try {
      const data = JSON.parse(text);
      return res.status(200).json(data);
    } catch (e) {
      return res.status(200).send(text);
    }
  } catch (err) {
    console.error('[Vercel GAS Proxy Error]:', err);
    return res.status(500).json({ success: false, error: 'Lỗi kết nối tới máy chủ Google Apps Script: ' + (err.message || err.toString()) });
  }
}
