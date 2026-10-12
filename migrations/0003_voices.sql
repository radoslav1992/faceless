-- Narration voices, chosen and described by administrators (Admin → Voices, server/voices.ts). `id` is the public ID
-- videos and series keep (it never changes); `provider_id` the ElevenLabs voice. Hidden voices (active=0) are not
-- offered for new videos and series, but the videos and series that use one keep it. One voice is the default.
CREATE TABLE voices (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 2 AND 40),
  provider_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  gender TEXT NOT NULL DEFAULT '' CHECK(gender IN ('female','male','neutral','')),
  accent TEXT NOT NULL DEFAULT '',
  age TEXT NOT NULL DEFAULT '',
  preview_key TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX voices_order ON voices(active, sort, name);
CREATE UNIQUE INDEX voices_one_default ON voices(is_default) WHERE is_default=1;
-- The twelve ElevenLabs premade voices the app offered before voices were managed in Admin.
INSERT INTO voices(id,provider_id,name,description,gender,accent,is_default,sort,created_at,updated_at) VALUES
  ('aria','9BWtsMINqrJLrRacOk9x','Aria','Warm and upbeat','female','American',0,10,unixepoch(),unixepoch()),
  ('sarah','EXAVITQu4vr4xnSDxMaL','Sarah','Soft, friendly, conversational','female','American',0,20,unixepoch(),unixepoch()),
  ('jessica','cgSgspJ2msm6clMCkdW9','Jessica','Bright and expressive','female','American',0,30,unixepoch(),unixepoch()),
  ('laura','FGY2WhTYpPnrIDTdsKH5','Laura','Quirky and energetic','female','American',0,40,unixepoch(),unixepoch()),
  ('matilda','XrExE9yKIg1WjnnlVkGX','Matilda','Calm and trustworthy','female','American',0,50,unixepoch(),unixepoch()),
  ('alice','Xb7hH8MSUJpSbSDYk0k2','Alice','Clear and confident','female','British',0,60,unixepoch(),unixepoch()),
  ('liam','TX3LPaxmHKxFdv7VOQHJ','Liam','Young and energetic','male','American',0,70,unixepoch(),unixepoch()),
  ('chris','iP95p4xoKVk53GoZ742B','Chris','Casual and natural','male','American',0,80,unixepoch(),unixepoch()),
  ('eric','cjVigY5qzO86Huf0OWal','Eric','Smooth and friendly','male','American',0,90,unixepoch(),unixepoch()),
  ('brian','nPczCjzI2devNBz1zQrb','Brian','Deep and reassuring','male','American',0,100,unixepoch(),unixepoch()),
  ('will','bIHbv24MWmeRgasZH58o','Will','Relaxed and optimistic','male','American',0,110,unixepoch(),unixepoch()),
  ('george','JBFqnCBsd6RMkjVDRZzb','George','Warm storyteller','male','British',1,120,unixepoch(),unixepoch());
