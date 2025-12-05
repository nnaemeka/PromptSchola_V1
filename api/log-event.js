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
    const { eventType, nanoSlug, step, userType, plan } = req.body || {};

    if (!eventType) {
      res.status(400).json({ error: 'Missing eventType' });
      return;
    }

    // Optional: nanoSlug & step are allowed to be null for global events.
    const safeUserType =
      userType === 'logged' || userType === 'anon' ? userType : 'anon';

    // Vercel injects geo headers you can use for a tiny country code
    let countryCode = req.headers['x-vercel-ip-country'] || null;
    if (countryCode && typeof countryCode === 'string') {
      countryCode = countryCode.slice(0, 2).toUpperCase();
    } else {
      countryCode = null;
    }

    const { error } = await supabaseAdmin
      .from('analytics_events_raw')
      .insert({
        event_type: eventType,
        nano_slug: nanoSlug || null,
        step: step ?? null,
        user_type: safeUserType,
        country_code: countryCode,
        plan: plan || null
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
