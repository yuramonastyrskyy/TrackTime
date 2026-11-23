// Riders after Stop (Android app): the lap leaders under the session summary,
// and the review sheet where the guesses are checked before sending to
// Pacemaker. Matching itself is in js/riders.js; this only draws and takes taps.

import { IGNORED } from './riders.js';
import { formatLap } from './detector.js';

const $ = (id) => document.getElementById(id);

export class RidersView {
  /**
   * get(): { run, session, decimals } for the last session (run may be null
   * while the app is still describing frames). changed(): after a correction
   * or a new name (save the session and the riders).
   */
  constructor({ get, changed }) {
    this.get = get;
    this.changed = changed;
    this.pick = null; // { key, i } while choosing who a crossing is
    this.els = {
      sum: $('sumRiders'), leaders: $('sumLeaders'), btn: $('ridersBtn'), btnLabel: $('ridersBtnLabel'),
      dlg: $('riders'), sub: $('ridersSub'), wait: $('ridersWait'), roster: $('riderRoster'), laps: $('riderLaps'),
      pickBox: $('riderPick'), pickTitle: $('riderPickTitle'), pickList: $('riderPickList'),
      pickNew: $('riderPickNew'), pickIgnore: $('riderPickIgnore'), pickCancel: $('riderPickCancel'),
    };
    this.els.btn.addEventListener('click', () => this.open());
    this.els.leaders.addEventListener('click', () => this.open());
    this.els.pickNew.addEventListener('click', () => this.choose(null));
    this.els.pickIgnore.addEventListener('click', () => this.choose(IGNORED));
    this.els.pickCancel.addEventListener('click', () => { this.pick = null; this.render(); });
    this.els.dlg.addEventListener('close', () => { this.pick = null; this.renderSummary(); });
  }

  keys() {
    const { session } = this.get();
    return session ? [0, ...session.laps.map((l) => l.lap)] : [];
  }

  /** Under the summary: one picture per lap (its leader), and the button. */
  renderSummary(waiting = null) {
    const { session } = this.get();
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

  open() {
    this.pick = null;
    this.render();
    if (!this.els.dlg.open) this.els.dlg.showModal();
  }

  render() {
    const { run, session, decimals } = this.get();
    const e = this.els;
    const R = session?.riders;
    if (!R) {
      e.roster.replaceChildren(); e.laps.replaceChildren();
      e.wait.hidden = false; e.wait.textContent = 'Still looking at the last laps…';
      return;
    }
    e.wait.hidden = true;
    const keys = this.keys();
    const unsure = keys.filter((k) => R.laps[k]?.leader && !R.laps[k].sure).length;
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
        run?.book.rename(r.id, name.value);
        r.name = name.value.trim() || r.name;
        this.changed();
        this.render();
      });
      const small = document.createElement('small');
      const n = led.get(r.id) || 0;
      small.textContent = n ? `led ${n} ${n === 1 ? 'lap' : 'laps'}` : 'led none';
      box.append(name, small);
      return box;
    }));

    // Laps: crossings in order, the leader marked; unsure ones dashed with "?".
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
      const w = run?.window(k);
      x.order.forEach((o, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        const isLead = o.id === x.leader && o.id !== IGNORED && i === x.order.findIndex((q) => q.id === x.leader);
        btn.className = `xing${isLead ? ' lead' : ''}${!o.sure && o.id !== IGNORED ? ' unsure' : ''}${o.id === IGNORED ? ' ignored' : ''}${this.pick && this.pick.key === k && this.pick.t === o.t ? ' picking' : ''}`;
        const who = o.id === IGNORED ? 'not a rider' : (byId.get(o.id)?.name || '?');
        btn.append(picture(o.thumb, who));
        const s = document.createElement('span'); s.textContent = who;
        btn.append(s);
        btn.setAttribute('aria-label', `${k === 0 ? 'Start' : `Lap ${k}`}, ${isLead ? 'first: ' : ''}${who}${o.sure ? '' : ', unsure'}`);
        if (w) btn.addEventListener('click', () => { this.pick = { key: k, t: o.t }; this.render(); });
        else btn.disabled = true;
        row.append(btn);
      });
      li.append(head, row);
      return li;
    }));

    // The picker.
    e.pickBox.hidden = !this.pick;
    if (this.pick) {
      e.pickTitle.textContent = `Who is this? (${this.pick.key === 0 ? 'start' : `lap ${this.pick.key}`})`;
      e.pickList.replaceChildren(...R.riders.concat(run ? run.book.riders.filter((r) => !byId.has(r.id)).map((r) => ({ id: r.id, name: r.name, thumb: r.thumb })) : []).map((r) => {
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
    const { run } = this.get();
    const p = this.pick;
    this.pick = null;
    if (!run || !p) { this.render(); return; }
    const w = run.window(p.key);
    if (w) {
      const i = w.crossings.findIndex((c) => Math.round(c.t - w.T) === p.t);
      if (i >= 0) run.correct(p.key, i, id);
    }
    this.changed();
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
