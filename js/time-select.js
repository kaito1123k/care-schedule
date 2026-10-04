// 15分きざみの時刻選択（<time-select>）
// iPhoneのSafariは <input type="time"> の step を無視して1分きざみになるため、
// 「時」と「分」の2つのセレクトで作る。value は "HH:MM"（未選択は ""）で、
// <input type="time"> と同じように .value の読み書きと input / change イベントが使える。

const STEP = 15;
const pad = (n) => String(n).padStart(2, '0');
const BASE_MINUTES = Array.from({ length: 60 / STEP }, (_, i) => pad(i * STEP));

class TimeSelect extends HTMLElement {
  connectedCallback() {
    if (this.hour) return;
    const label = this.getAttribute('aria-label') || '';
    this.hour = document.createElement('select');
    this.minute = document.createElement('select');
    this.hour.setAttribute('aria-label', `${label}（時）`);
    this.minute.setAttribute('aria-label', `${label}（分）`);
    this.hour.innerHTML = '<option value="">--</option>'
      + Array.from({ length: 24 }, (_, h) => `<option value="${pad(h)}">${h}</option>`).join('');
    const colon = document.createElement('span');
    colon.className = 'colon';
    colon.textContent = ':';
    colon.setAttribute('aria-hidden', 'true');
    this.append(this.hour, colon, this.minute);
    this.renderMinutes('');
    this.hour.addEventListener('change', () => {
      // 時だけ選んだら分は00にする。時を空にしたら分も空にする
      if (this.hour.value && !this.minute.value) this.minute.value = '00';
      if (!this.hour.value) this.minute.value = '';
      this.emit();
    });
    this.minute.addEventListener('change', () => {
      if (this.minute.value && !this.hour.value) this.minute.value = '';
      this.emit();
    });
    if (this.pending !== undefined) this.value = this.pending;
  }

  /** 15分きざみ以外の時刻（以前に入れた 9:10 など）も消さずに選べるよう、その分だけ選択肢に足す */
  renderMinutes(extra) {
    const mins = [...BASE_MINUTES];
    if (extra && !mins.includes(extra)) mins.push(extra);
    mins.sort();
    this.minute.innerHTML = '<option value="">--</option>' + mins.map((m) => `<option value="${m}">${m}</option>`).join('');
  }

  emit() {
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }

  get value() {
    if (!this.hour) return this.pending || '';
    return this.hour.value && this.minute.value ? `${this.hour.value}:${this.minute.value}` : '';
  }

  set value(v) {
    if (!this.hour) { this.pending = v; return; }
    const m = /^(\d{2}):(\d{2})$/.exec(v || '');
    this.renderMinutes(m ? m[2] : '');
    this.hour.value = m ? m[1] : '';
    this.minute.value = m ? m[2] : '';
  }
}

customElements.define('time-select', TimeSelect);
