/**
 * Durable image storage for agent-sourced question images.
 *
 * Autoscale instances have ephemeral, unshared disks, so images uploaded at runtime cannot live in
 * client/public. Images go to an object storage bucket and are served back through
 * GET /question-images/agent/:file (see registerQuestionAgentRoutes).
 *
 * Drivers (QUESTION_AGENT_IMAGE_DRIVER, or auto-detected):
 *  - "s3":     S3 or any S3-compatible service. Needs S3_BUCKET (+ S3_REGION, optional S3_ENDPOINT,
 *              and the standard AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).
 *  - "replit": Replit Object Storage. Optional IMAGE_BUCKET_ID; otherwise the app's default bucket.
 *  - "local":  disk under server/data/agent-images. Development only; refused in production.
 */
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

export type BucketDriverName = "s3" | "replit" | "local";

export interface StoredImage {
  body: Buffer;
  contentType: string;
}

export interface ImageBucket {
  driver: BucketDriverName;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredImage | null>;
}

export const AGENT_IMAGE_PREFIX = "question-agent/";
export const AGENT_IMAGE_URL_PREFIX = "/question-images/agent/";
/** Only strict, generated names are ever served or stored. */
export const AGENT_IMAGE_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif)$/;

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

export function allowedImageMime(mime: string): boolean {
  return mime in EXT_BY_MIME;
}

export function newAgentImageFilename(mime: string): string {
  const ext = EXT_BY_MIME[mime];
  if (!ext) throw new Error(`Unsupported image type: ${mime}`);
  return `${randomUUID()}.${ext}`;
}

export function contentTypeForFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** Sniff the real image type from magic bytes (never trust the client-declared mime). */
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("ascii"))) return "image/gif";
  return null;
}

function detectDriver(): BucketDriverName {
  const explicit = process.env.QUESTION_AGENT_IMAGE_DRIVER?.trim().toLowerCase();
  if (explicit === "s3" || explicit === "replit" || explicit === "local") return explicit;
  if (process.env.S3_BUCKET?.trim()) return "s3";
  if (process.env.IMAGE_BUCKET_ID?.trim() || process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID?.trim()) return "replit";
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "No image bucket configured. Set S3_BUCKET (S3) or IMAGE_BUCKET_ID (Replit Object Storage), or QUESTION_AGENT_IMAGE_DRIVER."
    );
  }
  return "local";
}

function s3Bucket(): ImageBucket {
  const bucket = process.env.S3_BUCKET?.trim();
  if (!bucket) throw new Error("S3_BUCKET is not set.");
  let clientPromise: Promise<{
    client: import("@aws-sdk/client-s3").S3Client;
    sdk: typeof import("@aws-sdk/client-s3");
  }> | null = null;
  const getClient = () => {
    clientPromise ??= import("@aws-sdk/client-s3").then((sdk) => ({
      sdk,
      client: new sdk.S3Client({
        region: process.env.S3_REGION?.trim() || "us-east-1",
        endpoint: process.env.S3_ENDPOINT?.trim() || undefined,
        forcePathStyle: !!process.env.S3_ENDPOINT?.trim(),
      }),
    }));
    return clientPromise;
  };
  return {
    driver: "s3",
    async put(key, body, contentType) {
      const { client, sdk } = await getClient();
      await client.send(
        new sdk.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType })
      );
    },
    async get(key) {
      const { client, sdk } = await getClient();
      try {
        const out = await client.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!out.Body) return null;
        const bytes = await out.Body.transformToByteArray();
        return {
          body: Buffer.from(bytes),
          contentType: out.ContentType || contentTypeForFilename(key),
        };
      } catch (err: any) {
        if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },
  };
}

function replitBucket(): ImageBucket {
  let clientPromise: Promise<import("@replit/object-storage").Client> | null = null;
  const getClient = () => {
    clientPromise ??= import("@replit/object-storage").then((m) => {
      const bucketId = process.env.IMAGE_BUCKET_ID?.trim();
      return bucketId ? new m.Client({ bucketId }) : new m.Client();
    });
    return clientPromise;
  };
  return {
    driver: "replit",
    async put(key, body) {
      const client = await getClient();
      const res = await client.uploadFromBytes(key, body);
      if (!res.ok) throw new Error(`Object storage upload failed: ${res.error?.message ?? "unknown error"}`);
    },
    async get(key) {
      const client = await getClient();
      const res = await client.downloadAsBytes(key);
      if (!res.ok) {
        if (/not.?found|no such|does not exist/i.test(res.error?.message ?? "")) return null;
        throw new Error(`Object storage download failed: ${res.error?.message ?? "unknown error"}`);
      }
      const [bytes] = res.value;
      return { body: Buffer.from(bytes), contentType: contentTypeForFilename(key) };
    },
  };
}

function localBucket(): ImageBucket {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The local image driver is not allowed in production.");
  }
  const dir = path.join(process.cwd(), "server/data/agent-images");
  const fileFor = (key: string) => path.join(dir, path.basename(key));
  return {
    driver: "local",
    async put(key, body) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fileFor(key), body);
    },
    async get(key) {
      const file = fileFor(key);
      if (!fs.existsSync(file)) return null;
      return { body: fs.readFileSync(file), contentType: contentTypeForFilename(key) };
    },
  };
}

let cached: ImageBucket | null = null;

export function getImageBucket(): ImageBucket {
  if (cached) return cached;
  const driver = detectDriver();
  cached = driver === "s3" ? s3Bucket() : driver === "replit" ? replitBucket() : localBucket();
  return cached;
}

/** For tests. */
export function resetImageBucketForTests(): void {
  cached = null;
}

/** Store validated image bytes; returns the public URL path saved in questions.image_url. */
export async function storeAgentImage(body: Buffer, mime: string): Promise<{ url: string; filename: string }> {
  const filename = newAgentImageFilename(mime);
  await getImageBucket().put(`${AGENT_IMAGE_PREFIX}${filename}`, body, mime);
  return { url: `${AGENT_IMAGE_URL_PREFIX}${filename}`, filename };
}

export async function loadAgentImage(filename: string): Promise<StoredImage | null> {
  if (!AGENT_IMAGE_FILE_RE.test(filename)) return null;
  return getImageBucket().get(`${AGENT_IMAGE_PREFIX}${filename}`);
}
