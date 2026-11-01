-- Run as one Wrangler D1 batch after a deployment that changes accounting.
INSERT INTO ai_usage_totals(period,bucket,units,charged_microusd)
SELECT 'month:' || month, 'all', sum(units), sum(charged_microusd) FROM ai_usage WHERE 1 GROUP BY month
ON CONFLICT(period,bucket) DO UPDATE SET units=excluded.units, charged_microusd=excluded.charged_microusd;
INSERT INTO ai_usage_totals(period,bucket,units,charged_microusd)
SELECT 'day:' || day, kind, sum(units), sum(charged_microusd) FROM ai_usage WHERE 1 GROUP BY day,kind
ON CONFLICT(period,bucket) DO UPDATE SET units=excluded.units, charged_microusd=excluded.charged_microusd;
