import { cleanup, fireEvent, render } from '@testing-library/react';
import type { PictureItem } from '@keel/protocol';
import { emptyState } from '@keel/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Picture, Plain, textWidth } from '../src';

afterEach(cleanup);

const state = emptyState();

const card: PictureItem = {
  id: 'a1',
  kind: 'picture',
  answers: ['m1'],
  picture: {
    kind: 'text',
    title: 'My read, and two questions',
    body: 'Many clients, one model, and a middle that takes turns.',
    points: ['The model exists.', 'The middle is what we design.'],
    lean: 'A. It keeps one thread for the model.',
    questions: ['Is 64 open requests a fair cap?', 'Shall I draw A in full?'],
  },
};

describe('the text card', () => {
  it('draws the star header, body, points, lean and questions', () => {
    const { container, getByText } = render(<Picture item={card} state={state} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.dataset.kind).toBe('text');
    expect(root.querySelector('.kp-card__head svg')).not.toBeNull();
    expect(getByText('My read, and two questions')).toBeTruthy();
    expect(getByText(/Many clients, one model/)).toBeTruthy();
    expect(container.querySelectorAll('.kp-text__points li')).toHaveLength(2);
    expect(container.querySelector('.kp-text__lean')?.textContent).toBe('My read: A. It keeps one thread for the model.');
  });

  it('makes each question a tap target q:1, q:2', () => {
    const onAct = vi.fn();
    const { container } = render(<Picture item={card} state={state} onAct={onAct} />);
    const subs = [...container.querySelectorAll<HTMLElement>('[data-sub]')].map((e) => e.dataset.sub);
    expect(subs).toEqual(['q:1', 'q:2']);
    fireEvent.click(container.querySelector('[data-sub="q:2"]')!);
    expect(onAct).toHaveBeenCalledWith({ type: 'tap', item: 'a1', sub: 'q:2' });
  });

  it('dims what the owner crossed out and outlines what was circled', () => {
    const { container, rerender } = render(<Picture item={card} state={state} markings={{ crossed: ['q:1'], circled: ['q:2'] }} />);
    expect(container.querySelector('[data-sub="q:1"]')!.className).toContain('kp--crossed');
    expect(container.querySelector('[data-sub="q:2"]')!.className).toContain('kp--circled');
    rerender(<Picture item={card} state={state} markings={{ crossed: [''], circled: [] }} />);
    expect((container.firstElementChild as HTMLElement).className).toContain('kp--crossed');
  });

  it('grows in three steps with what it says', () => {
    expect(textWidth({ kind: 'text', title: 'Short' })).toBe(380);
    expect(textWidth({ kind: 'text', title: 'x', body: 'y'.repeat(300) })).toBe(460);
    expect(textWidth({ kind: 'text', title: 'x', body: 'y'.repeat(600) })).toBe(540);
  });

  it('holds no position of its own', () => {
    const { container } = render(<Picture item={card} state={state} />);
    const style = (container.firstElementChild as HTMLElement).style;
    expect(style.left).toBe('');
    expect(style.top).toBe('');
    expect(style.position).toBe('');
  });
});

describe('the placeholder and the plain card', () => {
  it('draws a placeholder while the agent is drawing', () => {
    const { container, getByText } = render(<Picture item={{ ...card, status: 'drawing' }} state={state} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.dataset.status).toBe('drawing');
    expect(root.getAttribute('aria-busy')).toBe('true');
    expect(getByText('My read, and two questions')).toBeTruthy();
    expect(container.querySelector('[data-sub]')).toBeNull();
  });

  it('has a plain card for a kind with no renderer', () => {
    const item: PictureItem = {
      id: 'a2',
      kind: 'picture',
      from: ['a1'],
      picture: { kind: 'mini', title: 'Yes. One thread means one line', boxes: [{ text: 'http' }, { text: 'sched' }], caption: 'One line of work.' },
    };
    const { container, getByText } = render(<Plain item={item} state={state} />);
    expect((container.firstElementChild as HTMLElement).dataset.kind).toBe('mini');
    expect(container.querySelector('.kp-plain')).not.toBeNull();
    expect(getByText('Yes. One thread means one line')).toBeTruthy();
    expect(getByText('One line of work.')).toBeTruthy();
  });
});
