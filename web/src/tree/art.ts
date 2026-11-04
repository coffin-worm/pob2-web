/**
 * PoB's tree artwork, as a browser can use it.
 *
 * The game ships its node art as zstd-compressed DDS texture arrays, which a
 * canvas cannot read at all. `web/tools/tree_art.py` unpacks those once into
 * a WebP atlas plus a manifest of sprite rects, and this loads the result.
 *
 * The contract between the two sides is PoB's own asset names — `node.icon`
 * and `node.overlay[state]`, forwarded untouched by the bridge — so nothing
 * here or in the extractor decides which picture a node gets.
 *
 * The art is a build product and may simply not be there. Every lookup
 * returns null in that case and the tree falls back to drawing circles, so a
 * missing extraction costs appearance and nothing else.
 */

export interface SpriteRect {
  /** Which atlas page. */
  p: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Manifest {
  treeVersion: string;
  pages: { file: string; w: number; h: number }[];
  sprites: Record<string, SpriteRect>;
  backdrops: Record<string, { file: string; w: number; h: number }>;
}

const BASE = '/tree-art';

async function loadBitmap(url: string): Promise<ImageBitmap> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  // createImageBitmap decodes off the main thread, which matters here: the
  // atlas is 4000px square and decoding it inline would drop frames on the
  // one tick where it lands.
  return createImageBitmap(await response.blob());
}

export class TreeArt {
  private readonly manifest: Manifest;
  private readonly pages: (ImageBitmap | null)[];
  private readonly backdropCache = new Map<string, ImageBitmap | null>();

  private constructor(manifest: Manifest, pages: (ImageBitmap | null)[]) {
    this.manifest = manifest;
    this.pages = pages;
  }

  static async load(): Promise<TreeArt | null> {
    try {
      const response = await fetch(`${BASE}/manifest.json`);
      if (!response.ok) return null;
      const manifest = (await response.json()) as Manifest;
      const pages = await Promise.all(
        manifest.pages.map((page) => loadBitmap(`${BASE}/${page.file}`)),
      );
      return new TreeArt(manifest, pages);
    } catch {
      return null;
    }
  }

  sprite(name: string | undefined): SpriteRect | null {
    if (!name) return null;
    return this.manifest.sprites[name] ?? null;
  }

  page(index: number): ImageBitmap | null {
    return this.pages[index] ?? null;
  }

  /**
   * A painted backdrop, fetched on first ask.
   *
   * There are 37 of these at up to 2048px and at most two are ever on
   * screen, so they are not in the atlas and not fetched up front. Returns
   * null until the image arrives; the render loop is already redrawing every
   * frame, so it appears on its own without anything to notify.
   */
  backdrop(name: string | undefined): ImageBitmap | null {
    if (!name) return null;
    const cached = this.backdropCache.get(name);
    if (cached !== undefined) return cached;

    const entry = this.manifest.backdrops[name];
    if (!entry) {
      this.backdropCache.set(name, null);
      return null;
    }

    // Marked pending with null so the fetch is not started again next frame.
    this.backdropCache.set(name, null);
    void loadBitmap(`${BASE}/${entry.file}`)
      .then((bitmap) => this.backdropCache.set(name, bitmap))
      .catch(() => undefined);
    return null;
  }
}
