import { useEffect, useState } from 'react';

/** Read an asset with the page's token, as `BoardSource.readAsset` does. */
export type ReadAsset = (asset: string) => Promise<Blob | undefined>;

/** An asset's object URL: nothing while it is read, `null` when it could not be. */
type Url = string | null | undefined;

interface Held {
  users: number;
  url: Url;
  ready: Promise<string | null>;
}

/** The object URL of each asset some file on the board draws, kept while any of them is on the board. */
const held = new Map<string, Held>();

function take(asset: string, read: ReadAsset): Held {
  let h = held.get(asset);
  if (!h) {
    const ready = read(asset).then(
      (blob) => (blob ? URL.createObjectURL(blob) : null),
      () => null,
    );
    const made: Held = { users: 0, url: undefined, ready };
    void ready.then((url) => (made.url = url));
    held.set(asset, made);
    h = made;
  }
  h.users++;
  return h;
}

function give(asset: string, h: Held): void {
  if (--h.users > 0) return;
  held.delete(asset);
  void h.ready.then((url) => url && URL.revokeObjectURL(url));
}

/**
 * The object URL a file draws its picture from, read once for every file on the board that
 * shows this asset: a pan, a zoom or a redraw never reads it again. It is revoked when the last
 * of them leaves the board. The token never goes into a link: the bytes are read with it, and
 * the URL is the page's own.
 */
export function useAssetUrl(asset: string, read: ReadAsset | undefined): Url {
  const [url, setUrl] = useState<Url>(() => held.get(asset)?.url);
  useEffect(() => {
    if (!read) return undefined;
    const h = take(asset, read);
    let live = true;
    void h.ready.then((u) => live && setUrl(u));
    return () => {
      live = false;
      give(asset, h);
    };
  }, [asset, read]);
  return url;
}
