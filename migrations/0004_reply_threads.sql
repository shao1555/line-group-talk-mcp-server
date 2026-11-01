ALTER TABLE messages ADD COLUMN quoted_message_id TEXT;
ALTER TABLE bot_replies ADD COLUMN line_message_id TEXT;
CREATE UNIQUE INDEX bot_replies_line_message ON bot_replies(line_message_id);
