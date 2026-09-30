'use strict';

/**
 * SellAuth "Dynamic Delivery" endpoint.
 *
 * SellAuth POSTs one JSON request per invoice item to the webhook URL set on
 * the product (Deliverables -> Dynamic Delivery). We answer HTTP 200 with the
 * text to hand to the customer: one line = one deliverable. Here that is a
 * single freshly generated redeem key worth N boosts.
 *
 *   Webhook URL : https://YOUR-DOMAIN/api/sellauth/deliver
 *   Per product : https://YOUR-DOMAIN/api/sellauth/deliver?boosts=14
 *
 * Security  : every request carries X-Signature = HMAC-SHA256(rawBody, secret)
 *             (secret: Storefront -> Configure -> Miscellaneous in SellAuth).
 * Retries   : SellAuth retries on timeouts, so the Idempotency-Key header is
 *             stored — a retry gets the SAME key back instead of a new one.
 */

const crypto = require('crypto');
const express = require('express');
const supabase = require('../config/supabase');
const { asyncHandler, generateKeyCode } = require('../utils/helpers');
const { getConfig } = require('../services/config');

const router = express.Router();

async function getWebhookSecret() {
  return process.env.SELLAUTH_WEBHOOK_SECRET || (await getConfig('sellauth_webhook_secret')) || '';
}

function validSignature(rawBody, header, secret) {
  if (!rawBody || !header || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const got = String(header).trim().toLowerCase();
  if (got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
}

// First defined, non-empty value among several possible payload paths — the
// exact payload layout can differ between SellAuth versions, so be lenient.
function pick(obj, paths) {
  for (const p of paths) {
    let cur = obj;
    for (const part of p.split('.')) {
      cur = cur == null ? undefined : cur[part];
    }
    if (cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return null;
}

async function resolveBoosts(req, body) {
  // 1) explicit ?boosts=N on the webhook URL of that product
  const fromQuery = parseInt(req.query.boosts, 10);
  if (Number.isInteger(fromQuery) && fromQuery > 0) return { boosts: fromQuery, via: 'url' };

  // 2) admin mapping: variant id first, then product id
  const variantId = pick(body, ['variant.id', 'variant_id', 'item.variant.id', 'item.variant_id', 'product.variant.id']);
  const productId = pick(body, ['product.id', 'product_id', 'item.product.id', 'item.product_id']);
  const ids = [variantId, productId].filter((v) => v !== null).map(String);
  if (ids.length) {
    const { data } = await supabase
      .from('sellauth_products')
      .select('sellauth_id, boosts_value')
      .in('sellauth_id', ids);
    for (const id of ids) {
      const hit = (data || []).find((r) => r.sellauth_id === id);
      if (hit) return { boosts: hit.boosts_value, via: 'mapping' };
    }
  }

  // 3) "14 Boosts" in the variant / product name
  const names = [
    pick(body, ['variant.name', 'item.variant.name', 'product.variant.name']),
    pick(body, ['product.name', 'item.product.name']),
  ].filter(Boolean);
  for (const name of names) {
    const m = String(name).match(/(\d{1,3})\s*(?:x\s*)?boosts?/i);
    if (m && Number(m[1]) > 0) return { boosts: Number(m[1]), via: 'name' };
  }

  // 4) default from the admin panel
  const def = parseInt(await getConfig('sellauth_default_boosts'), 10);
  if (Number.isInteger(def) && def > 0) return { boosts: def, via: 'default' };

  return null;
}

router.get('/health', asyncHandler(async (req, res) => {
  res.json({ ok: true, secretConfigured: Boolean(await getWebhookSecret()) });
}));

router.post(
  '/deliver',
  asyncHandler(async (req, res) => {
    const secret = await getWebhookSecret();
    if (!secret) {
      return res.status(503).type('text/plain').send('SellAuth webhook secret is not configured');
    }
    if (!validSignature(req.rawBody, req.get('X-Signature'), secret)) {
      return res.status(401).type('text/plain').send('Invalid signature');
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const idem =
      req.get('Idempotency-Key') ||
      crypto.createHash('sha256').update(req.rawBody).digest('hex');

    const invoiceId = pick(body, ['invoice.id', 'invoice_id', 'invoice.unique_id', 'id']);
    const productId = pick(body, ['product.id', 'product_id', 'item.product.id']);
    const productName = pick(body, ['product.name', 'item.product.name']);
    const payload = JSON.stringify(body).length < 20000 ? body : { truncated: true };

    // Retry of a delivery we already completed -> same key, no new one.
    const { data: existing } = await supabase
      .from('sellauth_deliveries')
      .select('id, status, key_code')
      .eq('idempotency_key', idem)
      .maybeSingle();
    if (existing && existing.status === 'delivered' && existing.key_code) {
      return res.status(200).type('text/plain').send(existing.key_code);
    }

    const resolved = await resolveBoosts(req, body);
    const base = {
      idempotency_key: idem,
      invoice_id: invoiceId != null ? String(invoiceId) : null,
      product_id: productId != null ? String(productId) : null,
      product_name: productName != null ? String(productName).slice(0, 200) : null,
      payload,
    };

    if (!resolved) {
      const row = { ...base, status: 'error', error: 'Could not work out how many boosts this product is worth' };
      if (existing) await supabase.from('sellauth_deliveries').update(row).eq('id', existing.id);
      else await supabase.from('sellauth_deliveries').insert(row);
      return res.status(422).type('text/plain').send('Product is not linked to a boost amount');
    }

    // Create the key (unique 16-char code, retry on the rare collision).
    let key = null;
    for (let i = 0; i < 5 && !key; i += 1) {
      const { data, error } = await supabase
        .from('redeem_keys')
        .insert({
          code: generateKeyCode(),
          boosts_value: resolved.boosts,
          source: 'sellauth',
          note: base.invoice_id ? `SellAuth invoice ${base.invoice_id}` : 'SellAuth',
        })
        .select('id, code')
        .single();
      if (!error) key = data;
      else if (!/duplicate|unique/i.test(error.message || '')) throw error;
    }
    if (!key) throw new Error('Could not generate a unique key');

    const row = { ...base, boosts_value: resolved.boosts, key_code: key.code, status: 'delivered', error: null };
    let saveErr;
    if (existing) {
      ({ error: saveErr } = await supabase.from('sellauth_deliveries').update(row).eq('id', existing.id));
    } else {
      ({ error: saveErr } = await supabase.from('sellauth_deliveries').insert(row));
    }

    if (saveErr) {
      // Two identical requests raced: keep the first key, drop ours.
      await supabase.from('redeem_keys').delete().eq('id', key.id);
      const { data: winner } = await supabase
        .from('sellauth_deliveries')
        .select('key_code')
        .eq('idempotency_key', idem)
        .maybeSingle();
      if (winner?.key_code) return res.status(200).type('text/plain').send(winner.key_code);
      throw saveErr;
    }

    res.status(200).type('text/plain').send(key.code);
  })
);

module.exports = router;
