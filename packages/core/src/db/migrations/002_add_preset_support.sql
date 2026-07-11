ALTER TABLE spaces ADD COLUMN preset_id TEXT;
CREATE INDEX IF NOT EXISTS idx_spaces_preset_id ON spaces(preset_id);
