import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260916205955_v1_input_media_guard",
  fresh: true,
  up(tx) {
    return tx
      .run(
        `
      CREATE TRIGGER IF NOT EXISTS v1_input_images_require_parts
      BEFORE UPDATE OF state ON v1_session_input
      WHEN OLD.state = 'pending' AND NEW.state = 'promoted' AND json_array_length(OLD.images) > 0
      BEGIN
        SELECT RAISE(ABORT, 'Image inputs require an image-capable runtime; media remains pending')
        WHERE json_array_length(OLD.images) != (
          SELECT count(*) FROM part
          WHERE session_id = NEW.session_id AND message_id = json_extract(NEW.receipt, '$.messageID')
            AND json_extract(data, '$.type') = 'file'
        ) OR EXISTS (
          SELECT 1 FROM json_each(OLD.images) expected
          LEFT JOIN (
            SELECT row_number() OVER (ORDER BY id) - 1 AS ordinal, data FROM part
            WHERE session_id = NEW.session_id AND message_id = json_extract(NEW.receipt, '$.messageID')
              AND json_extract(data, '$.type') = 'file'
          ) actual ON actual.ordinal = CAST(expected.key AS INTEGER)
          WHERE actual.data IS NULL
            OR json_extract(actual.data, '$.url') IS NOT json_extract(expected.value, '$.url')
            OR json_extract(actual.data, '$.mime') IS NOT json_extract(expected.value, '$.mime')
            OR json_extract(actual.data, '$.filename') IS NOT json_extract(expected.value, '$.filename')
        );
      END;
    `,
      )
      .pipe(Effect.asVoid)
  },
} satisfies DatabaseMigration.Migration
