import type { Box, FileItem } from '@keel/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replay } from '@keel/protocol';
import { MarkView } from '../src/items';
import { Thumb } from '../src/StoryView';

/**
 * A file that is a picture, drawn as the picture (`FilePicture` in `src/items.tsx`): its bytes
 * read once with the page's token into an object URL that is kept while it is on the board, a
 * panel in its place while they come or when they cannot be shown, and the Open button still
 * there. Every other file is still the tile.
 */

const file = (over: Partial<FileItem> = {}): FileItem => ({ id: 'f1', kind: 'file', box: [0, 0, 200, 150], name: 'shot.png', asset: 'assets/shot.png', mime: 'image/png', size: 4096, ...over });
const SHOWN: Box = [0, 0, 200, 150];
const settle = () => act(async () => {});

let made: string[];
let revoked: string[];

beforeEach(() => {
  made = [];
  revoked = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:picture-${made.length + 1}`;
    made.push(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => void revoked.push(url));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const img = () => document.querySelector<HTMLImageElement>('.file-picture img');
const waiting = () => document.querySelector<HTMLElement>('.file-picture__wait');

describe('a file that is a picture', () => {
  it('draws an <img> from the bytes it read, named by the file, not draggable by the browser, straight; the panel holds its place until it has loaded', async () => {
    const read = vi.fn(async () => new Blob(['png'], { type: 'image/png' }));
    render(<MarkView item={file()} shown={SHOWN} read={read} />);
    expect(img()).toBeNull();
    expect(waiting()?.dataset.failed).toBeUndefined();
    await settle();
    expect(read).toHaveBeenCalledWith('assets/shot.png');
    expect(img()!.getAttribute('src')).toBe('blob:picture-1');
    expect(img()!.alt).toBe('shot.png');
    expect(img()!.getAttribute('draggable')).toBe('false');
    expect(document.querySelector<HTMLElement>('.file-picture')!.style.transform).toBe('');
    expect(document.querySelector('.file-tile')).toBeNull();
    expect(waiting()).not.toBeNull();
    fireEvent.load(img()!);
    expect(waiting()).toBeNull();
  });

  it('a picture the owner turned is drawn turned', async () => {
    render(<MarkView item={file({ rot: 3 })} shown={SHOWN} read={async () => new Blob(['png'])} />);
    await settle();
    expect(document.querySelector<HTMLElement>('.file-picture')!.style.transform).toBe('rotate(3deg)');
  });

  it('while its bytes are read: a quiet panel with a picture in its middle, as big as 40% of its shorter side, at most 100', () => {
    const { rerender } = render(<MarkView item={file()} shown={SHOWN} read={() => new Promise(() => {})} />);
    expect(screen.getByRole('img', { name: 'The picture is on its way' }).getAttribute('width')).toBe('60');
    expect(waiting()!.dataset.failed).toBeUndefined();
    expect(img()).toBeNull();
    rerender(<MarkView item={file()} shown={[0, 0, 1000, 800]} read={() => new Promise(() => {})} />);
    expect(screen.getByRole('img', { name: 'The picture is on its way' }).getAttribute('width')).toBe('100');
  });

  it('bytes that cannot be read: the panel, crossed', async () => {
    render(<MarkView item={file()} shown={SHOWN} read={async () => undefined} />);
    await settle();
    expect(img()).toBeNull();
    expect(waiting()!.dataset.failed).toBe('true');
    expect(screen.getByRole('img', { name: 'The picture could not be shown' })).toBeTruthy();
    expect(made).toEqual([]);
  });

  it('bytes that are not a picture the browser can decode: the panel, crossed', async () => {
    render(<MarkView item={file()} shown={SHOWN} read={async () => new Blob(['not a png'])} />);
    await settle();
    fireEvent.error(img()!);
    expect(img()).toBeNull();
    expect(screen.getByRole('img', { name: 'The picture could not be shown' })).toBeTruthy();
  });

  it('is read once, whatever is drawn again, and two files of one asset share it; the URL is revoked when the last leaves the board', async () => {
    const read = vi.fn(async () => new Blob(['png']));
    const one = render(<MarkView item={file()} shown={SHOWN} read={read} />);
    await settle();
    // Panned, zoomed, moved: drawn again at another box.
    one.rerender(<MarkView item={file()} shown={[40, 30, 200, 150]} read={read} />);
    one.rerender(<MarkView item={file({ box: [90, 10, 200, 150] })} shown={[90, 10, 200, 150]} read={read} />);
    await settle();
    const two = render(<MarkView item={file({ id: 'f2' })} shown={SHOWN} read={read} />);
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(made).toEqual(['blob:picture-1']);
    expect(two.container.querySelector('img')!.getAttribute('src')).toBe('blob:picture-1');
    one.unmount();
    await settle();
    expect(revoked).toEqual([]);
    two.unmount();
    await settle();
    expect(revoked).toEqual(['blob:picture-1']);
  });

  it('a file taken off the board before its bytes came revokes the URL they come in', async () => {
    let give = (_: Blob) => {};
    const { unmount } = render(<MarkView item={file()} shown={SHOWN} read={() => new Promise<Blob>((done) => (give = done))} />);
    unmount();
    give(new Blob(['png']));
    await settle();
    expect(made).toEqual(['blob:picture-1']);
    expect(revoked).toEqual(['blob:picture-1']);
  });

  it('Open still opens the file', async () => {
    const onOpen = vi.fn();
    render(<MarkView item={file()} shown={SHOWN} read={async () => new Blob(['png'])} onOpen={onOpen} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Open shot.png' }));
    expect(onOpen).toHaveBeenCalledWith('assets/shot.png', 'shot.png');
  });
});

describe('every other file', () => {
  it('a PDF and a text file are still the tile, with Open, and nothing is read', () => {
    const read = vi.fn(async () => new Blob(['x']));
    const onOpen = vi.fn();
    for (const [name, mime] of [
      ['plan.pdf', 'application/pdf'],
      ['notes.txt', 'text/plain'],
    ] as const) {
      const { unmount } = render(<MarkView item={file({ name, asset: `assets/${name}`, mime, box: [0, 0, 340, 60] })} shown={[0, 0, 340, 60]} read={read} onOpen={onOpen} />);
      expect(document.querySelector('.file-tile b')!.textContent).toBe(name);
      expect(document.querySelector('.file-picture')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: `Open ${name}` }));
      expect(onOpen).toHaveBeenLastCalledWith(`assets/${name}`, name);
      unmount();
    }
    expect(read).not.toHaveBeenCalled();
  });
});

describe('a picture in a Story thumbnail', () => {
  it('is drawn as the picture, from the bytes the Story was given a way to read', async () => {
    const item = file();
    const state = replay([
      { id: 'e1', at: '2026-11-22T10:00:00.000Z', by: 'system', type: 'board.open', name: 'test' },
      { id: 'e2', at: '2026-11-22T10:00:01.000Z', by: 'owner', type: 'chapter.open', chapter: 'c1', title: 'An idea' },
      { id: 'e3', at: '2026-11-22T10:00:02.000Z', by: 'owner', type: 'item.add', chapter: 'c1', item },
    ]);
    const read = vi.fn(async () => new Blob(['png'], { type: 'image/png' }));
    render(<Thumb ids={['f1']} state={state} boxOf={() => item.box} markings={{}} read={read} />);
    await settle();
    expect(read).toHaveBeenCalledWith('assets/shot.png');
    expect(document.querySelector<HTMLImageElement>('.thumb .file-picture img')!.getAttribute('src')).toBe('blob:picture-1');
  });
});
