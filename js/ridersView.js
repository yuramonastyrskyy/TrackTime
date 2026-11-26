// Riders after Stop (Android app): the lap leaders under the session summary,
// and the review sheet where the guesses are checked before sending to
// Pacemaker, for the session just timed or any saved one (Settings >
// Sessions > Review). Matching and corrections are in js/riders.js; this only
// draws and takes taps.

import { IGNORED, correctSaved, renameSaved, unsureLeaders } from './riders.js';
import { formatLap } from './detector.js';

const $ = (id) => document.getElementById(id);

export class RidersView {
  /**
   * book(): the riders kept between sessions. decimals(): lap time decimals.
   * changed(session): after a correction or a new name (save the session and
   * the book). closed(session): the sheet was closed.
   */
  constructor({ book, decimals, changed, closed = () => {} }) {
    this.book = book;
    this.decimals = decimals;
    this.changed = changed;
    this.closed = closed;
    this.session = null; // the session in the sheet
    this.pick = null; // { key, i } while choosing who a crossing is
    this.els = {
      sum: $('sumRiders'), leaders: $('sumLeaders'), btn: $('ridersBtn'), btnLabel: $('ridersBtnLabel'),
      dlg: $('riders'), sub: $('ridersSub'), wait: $('ridersWait'), roster: $('riderRoster'), laps: $('riderLaps'),
      pickBox: $('riderPick'), pickTitle: $('riderPickTitle'), pickList: $('riderPickList'),
      pickNew: $('riderPickNew'), pickIgnore: $('riderPickIgnore'), pickCancel: $('riderPickCancel'),
    };
    this.els.btn.addEventListener('click', () => this.open(this.summarySession));
    this.els.leaders.addEventListener('click', () => this.open(this.summarySession));
    this.els.pickNew.addEventListener('click', () => this.choose(null));
    this.els.pickIgnore.addEventListener('click', () => this.choose(IGNORED));
    this.els.pickCancel.addEventListener('click', () => { this.pick = null; this.render(); });
    this.els.dlg.addEventListener('close', () => {
      this.pick = null;
      this.renderSummary(this.summarySession, this.summaryWaiting);
      this.closed(this.session);
    });
    this.summarySession = null;
    this.summaryWaiting = null;
  }

  keys(session = this.session) {
    return session ? [0, ...session.laps.map((l) => l.lap)] : [];
  }

  /** Under the summary: one picture per lap (its leader), and the button. */
  renderSummary(session, waiting = null) {
    this.summarySession = session;
    this.summaryWaiting = waiting;
    const R = session?.riders;
    const e = this.els;
    if (!session || (!R && !waiting)) { e.sum.hidden = true; return; }
    e.sum.hidden = false;
    if (!R) {
      e.leaders.replaceChildren();
      e.btnLabel.textContent = waiting;
      e.btn.disabled = true;
      return;
    }
    e.btn.disabled = false;
    const byId = new Map(R.riders.map((r) => [r.id, r]));
    const imgs = [];
    let unsure = 0;
    for (const l of session.laps) {
      const x = R.laps[l.lap];
      if (!x || !x.leader) continue;
      if (!x.sure) unsure++;
      const r = byId.get(x.leader);
      const img = document.createElement('img');
      img.alt = `Lap ${l.lap}: ${r?.name || '?'}`;
      img.src = leaderThumb(x) || r?.thumb || '';
      if (!x.sure) img.className = 'unsure';
      imgs.push(img);
    }
    e.leaders.replaceChildren(...imgs);
    e.btnLabel.textContent = unsure ? `Check riders (${unsure} ?)` : 'Riders';
    e.btn.classList.toggle('send', unsure > 0);
  }

  /** The sheet for a session (the one just timed, or a saved one). */
  open(session) {
    if (!session) return;
    this.session = session;
    this.pick = null;
    this.render();
    if (!this.els.dlg.open) this.els.dlg.showModal();
  }

  render() {
    const session = this.session, decimals = this.decimals(), book = this.book();
    const e = this.els;
    const R = session?.riders;
    if (!R) {
      e.roster.replaceChildren(); e.laps.replaceChildren(); e.pickBox.hidden = true;
      e.wait.hidden = false; e.wait.textContent = 'Still looking at the last laps…';
      return;
    }
    e.wait.hidden = true;
    const keys = this.keys();
    const unsure = unsureLeaders(R, keys);
    e.sub.textContent = unsure ? ` · ${unsure} to check` : ' · all checked';

    // Riders: picture + name (editable), laps led.
    const led = new Map();
    for (const k of keys) if (k > 0 && R.laps[k]?.leader) led.set(R.laps[k].leader, (led.get(R.laps[k].leader) || 0) + 1);
    e.roster.replaceChildren(...R.riders.map((r) => {
      const box = document.createElement('div');
      box.className = 'rider';
      box.append(picture(r.thumb, r.name));
      const name = document.createElement('input');
      name.type = 'text'; name.value = r.name; name.maxLength = 30; name.setAttribute('aria-label', `Name of ${r.name}`);
      name.addEventListener('change', () => {
        if (renameSaved(R, book, r.id, name.value)) this.changed(session);
        this.render();
      });
      const small = document.createElement('small');
      const n = led.get(r.id) || 0;
      small.textContent = n ? `led ${n} ${n === 1 ? 'lap' : 'laps'}` : 'led none';
      box.append(name, small);
      return box;
    }));

    // Laps: who crossed first in each (one rider per lap); unsure ones dashed with "?".
    const byId = new Map(R.riders.map((r) => [r.id, r]));
    const lapMs = new Map(session.laps.map((l) => [l.lap, l.ms]));
    e.laps.replaceChildren(...keys.filter((k) => R.laps[k]?.order.length).map((k) => {
      const x = R.laps[k];
      const li = document.createElement('li');
      li.className = 'rider-lap';
      const head = document.createElement('div');
      head.className = 'k';
      const b = document.createElement('b');
      b.textContent = k === 0 ? 'Start' : `Lap ${k}`;
      head.append(b, k === 0 ? '' : formatLap(lapMs.get(k), decimals));
      const row = document.createElement('div');
      row.className = 'row-x';
      // One rider per lap: the one who crossed first (the others still teach the
      // app what each rider looks like, but are not shown for checking).
      const li0 = x.order.findIndex((q) => q.id === x.leader && q.id !== IGNORED);
      const shown = li0 >= 0 ? [li0] : x.order.length ? [x.order.findIndex((q) => q.id !== IGNORED)].filter((i) => i >= 0) : [];
      shown.map((i) => [x.order[i], i]).forEach(([o, i]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        const isLead = o.id === x.leader && o.id !== IGNORED && i === x.order.findIndex((q) => q.id === x.leader);
        btn.className = `xing${isLead ? ' lead' : ''}${!o.sure && o.id !== IGNORED ? ' unsure' : ''}${o.id === IGNORED ? ' ignored' : ''}${this.pick && this.pick.key === k && this.pick.i === i ? ' picking' : ''}`;
        const who = o.id === IGNORED ? 'not a rider' : (byId.get(o.id)?.name || '?');
        btn.append(picture(o.thumb, who));
        const s = document.createElement('span'); s.textContent = who;
        btn.append(s);
        btn.setAttribute('aria-label', `${k === 0 ? 'Start' : `Lap ${k}`}, ${isLead ? 'first: ' : ''}${who}${o.sure ? '' : ', unsure'}`);
        btn.addEventListener('click', () => { this.pick = { key: k, i }; this.render(); });
        row.append(btn);
      });
      li.append(head, row);
      return li;
    }));

    // The picker.
    e.pickBox.hidden = !this.pick;
    if (this.pick) {
      e.pickTitle.textContent = `Who is this? (${this.pick.key === 0 ? 'start' : `lap ${this.pick.key}`})`;
      e.pickList.replaceChildren(...R.riders.concat(book.riders.filter((r) => !byId.has(r.id)).map((r) => ({ id: r.id, name: r.name, thumb: r.thumb }))).map((r) => {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'rider';
        btn.append(picture(r.thumb, r.name));
        const s = document.createElement('small'); s.textContent = r.name;
        btn.append(s);
        btn.addEventListener('click', () => this.choose(r.id));
        return btn;
      }));
      e.pickBox.scrollIntoView?.({ block: 'nearest' });
    }
  }

  /** The picked crossing is rider id (null: a new rider; IGNORED: not a team rider). */
  choose(id) {
    const p = this.pick;
    this.pick = null;
    if (p && correctSaved(this.session?.riders, this.book(), p.key, p.i, id)) this.changed(this.session);
    this.render();
  }
}

function leaderThumb(x) {
  const o = x.order.find((q) => q.id === x.leader);
  return o?.thumb || null;
}

function picture(src, alt) {
  if (!src) {
    const d = document.createElement('div');
    d.className = 'noimg';
    d.setAttribute('aria-hidden', 'true');
    return d;
  }
  const img = document.createElement('img');
  img.src = src; img.alt = alt || '';
  return img;
}

/** Who led crossing `key` of a session: { name, thumb, sure }, or null. */
export function leaderOf(session, key) {
  const R = session?.riders;
  const x = R?.laps?.[key];
  if (!x || !x.leader) return null;
  const r = R.riders.find((q) => q.id === x.leader);
  return { name: r?.name || '?', thumb: leaderThumb(x) || r?.thumb || null, sure: !!x.sure };
}
export { picture };
