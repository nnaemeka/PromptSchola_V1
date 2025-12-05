// /api/log-event.js
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { eventType, nanoSlug, step } = req.body || {};

    if (!eventType || !nanoSlug) {
      res.status(400).json({ error: 'Missing eventType or nanoSlug' });
      return;
    }

    const ip =
      (req.headers['x-forwarded-for'] || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)[0] ||
      req.socket?.remoteAddress ||
      null;

    const country = req.headers['x-vercel-ip-country'] || null;
    const region = req.headers['x-vercel-ip-country-region'] || null;
    const userAgent = req.headers['user-agent'] || null;

    const user_id = null; // can be wired later using tokens if you want

    const { error } = await supabaseAdmin
      .from('analytics_events')
      .insert({
        user_id,
        nano_slug: nanoSlug,
        step: step ?? null,
        event_type: eventType,
        ip_address: ip,
        country,
        region,
        user_agent: userAgent
      });

    if (error) {
      console.error('Supabase insert error:', error);
      res.status(500).json({ error: 'Failed to log event' });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('log-event error:', err);
    res.status(500).json({ error: 'Unexpected error' });
  }
}
