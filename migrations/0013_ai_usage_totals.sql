CREATE TABLE ai_usage_totals (
  period TEXT NOT NULL,
  bucket TEXT NOT NULL,
  units INTEGER NOT NULL,
  charged_microusd INTEGER NOT NULL,
  PRIMARY KEY(period, bucket)
);
INSERT INTO ai_usage_totals(period, bucket, units, charged_microusd)
SELECT 'month:' || month, 'all', sum(units), sum(charged_microusd) FROM ai_usage GROUP BY month;
INSERT INTO ai_usage_totals(period, bucket, units, charged_microusd)
SELECT 'day:' || day, kind, sum(units), sum(charged_microusd) FROM ai_usage GROUP BY day, kind;
