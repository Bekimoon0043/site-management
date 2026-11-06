import { useState } from 'react';
import { HardHat } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { ErrorBanner } from '../components/Page';
import { Field } from '../components/Form';

export function Login() {
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const ident = id.trim();
    // FR-ACC-01: email or phone number + password
    const creds = ident.includes('@') ? { email: ident, password } : { phone: ident.replace(/[\s-]/g, ''), password };
    const { error: err } = await supabase.auth.signInWithPassword(creds);
    if (err) setError(err.message);
    setBusy(false);
  };

  return (
    <div className="center-page">
      <form className="login" onSubmit={(e) => void submit(e)}>
        <span className="brand-mark" aria-hidden><HardHat size={22} /></span>
        <div>
          <h1>Sign in to Site Console</h1>
          <div className="muted">Materials management &amp; progress tracking</div>
        </div>
        <ErrorBanner error={error} />
        <Field label="Email or phone" required>
          <input value={id} onChange={(e) => setId(e.target.value)} autoComplete="username" placeholder="name@company.et or +2519…" required autoFocus />
        </Field>
        <Field label="Password" required>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        <button className="primary lg" disabled={busy}>{busy && <span className="spinner" />}{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
