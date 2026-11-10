ALTER TABLE conversations
  ADD COLUMN working_directories_json TEXT NOT NULL DEFAULT '[]';

UPDATE conversations
SET working_directories_json = json_array(cwd)
WHERE cwd != '';
