import { z } from 'zod';
import { sessionRoute, body } from '@/lib/route';
import { files } from '@rppc/db';
const In = z.object({ purpose: z.enum(['pod_photo', 'signature', 'document', 'image']), mime: z.string(), size: z.number().int().positive(), sha256: z.string() });
// Any signed-in user may upload; an uploaded file grants nothing until a permission-checked action references it.
export const POST = sessionRoute('signed upload URL for own upload; files are inert until a permission-checked action links them', async (req, actor) =>
  files.createUploadIntent(actor, In.parse(await body(req))));
