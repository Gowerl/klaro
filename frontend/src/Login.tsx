import { useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from './firebaseConfig';

interface LoginProps {
  onLoginSuccess: () => void;
}

export function Login({ onLoginSuccess }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError('Bitte E-Mail und Passwort eingeben.');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      await signInWithEmailAndPassword(auth, email, password);
      onLoginSuccess();
    } catch (err: any) {
      console.error('Login-Fehler:', err);
      if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
        setError('Ungültige E-Mail-Adresse oder falsches Passwort.');
      } else if (err.code === 'auth/invalid-email') {
        setError('Ungültige E-Mail-Adresse.');
      } else {
        setError('Fehler bei der Anmeldung. Bitte versuche es später noch einmal.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-logo-container">
          <svg viewBox="0 0 24 24" className="login-logo-icon">
            <path d="M12,2.69C12,2.69 19,10.15 19,14A7,7 0 0,1 12,21A7,7 0 0,1 5,14C5,10.15 12,2.69 12,2.69M12,19.5A5.5,5.5 0 0,0 17.5,14C17.5,11.57 12.87,7.27 12,6.43C11.13,7.27 6.5,11.57 6.5,14A5.5,5.5 0 0,0 12,19.5Z" />
          </svg>
        </div>
        <h2>KLARO KI-Assistent</h2>
        <p className="login-subtitle">Melde dich an, um fortzufahren</p>

        {error && <div className="login-error-alert">{error}</div>}

        <form onSubmit={handleSubmit} className="login-form">
          <div className="form-group">
            <label htmlFor="email">E-Mail-Adresse</label>
            <input
              type="email"
              id="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="mitarbeiter@klaro.de"
              disabled={isLoading}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Passwort</label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              disabled={isLoading}
              required
            />
          </div>

          <button type="submit" className="login-submit-btn" disabled={isLoading}>
            {isLoading ? 'Melde an...' : 'Anmelden'}
          </button>
        </form>
      </div>
    </div>
  );
}
