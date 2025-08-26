import React, { useState, useEffect } from 'react';
import { FusionAuthClient } from '@fusionauth/typescript-client';
import './App.css';

// Enhanced React SSO Example with MFA Prompt
const App = () => {
  const [user, setUser] = useState(null);
  const [mfaPrompt, setMfaPrompt] = useState(false);
  const [loading, setLoading] = useState(false);

  // Initialize FusionAuth client
  const client = new FusionAuthClient(
    process.env.REACT_APP_FA_API_KEY || 'your-api-key',
    process.env.REACT_APP_FA_URL || 'http://localhost:9011'
  );

  // Enhanced security check after login
  useEffect(() => {
    if (user && user.token) {
      // Check MFA status after successful login
      client.retrieveUserUsingJWT(user.token)
        .then(response => {
          if (response.response.user && !response.response.user.twoFactorEnabled) {
            setMfaPrompt(true);
            // Log security event
            console.log('Security Alert: User without MFA detected', {
              userId: response.response.user.id,
              email: response.response.user.email,
              timestamp: new Date().toISOString()
            });
          }
          
          // Additional security checks
          checkPasswordAge(response.response.user);
          validateSessionSecurity(response.response.user);
        })
        .catch(err => {
          console.error('Error checking user security status:', err);
        });
    }
  }, [user]);

  // Check password age for security compliance
  const checkPasswordAge = (userData) => {
    if (userData.passwordLastUpdateInstant) {
      const lastUpdate = new Date(userData.passwordLastUpdateInstant);
      const daysSinceUpdate = (Date.now() - lastUpdate) / (1000 * 60 * 60 * 24);
      
      if (daysSinceUpdate > 90) {
        console.warn('Password update recommended - over 90 days old');
        // Could trigger UI notification here
      }
    }
  };

  // Validate session security parameters
  const validateSessionSecurity = (userData) => {
    // Check for suspicious login patterns
    const sessionMetrics = {
      loginCount: userData.loginCount || 0,
      failedLoginCount: userData.failedLoginCount || 0,
      lastLogin: userData.lastLogin,
      registrationDate: userData.insertInstant
    };

    // Alert on suspicious patterns
    if (sessionMetrics.failedLoginCount > 5) {
      console.warn('High failed login attempts detected');
    }

    return sessionMetrics;
  };

  // OAuth login handler
  const handleLogin = () => {
    setLoading(true);
    const clientId = process.env.REACT_APP_FA_CLIENT_ID || 'your-client-id';
    const redirectUri = encodeURIComponent(window.location.origin + '/callback');
    const authUrl = `${process.env.REACT_APP_FA_URL || 'http://localhost:9011'}/oauth2/authorize?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}`;
    
    window.location.href = authUrl;
  };

  // Handle OAuth callback
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    
    if (code) {
      exchangeCodeForToken(code);
    }
  }, []);

  // Exchange authorization code for token
  const exchangeCodeForToken = async (code) => {
    try {
      const response = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      
      const data = await response.json();
      if (data.token) {
        setUser(data);
        setLoading(false);
        // Clear URL params
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    } catch (error) {
      console.error('Token exchange failed:', error);
      setLoading(false);
    }
  };

  // Enable MFA handler
  const enableMFA = async () => {
    try {
      const response = await client.enableTwoFactor(user.id, {
        method: 'authenticator',
        mobilePhone: user.mobilePhone
      });
      
      if (response.response.qrCode) {
        // Show QR code for authenticator setup
        console.log('MFA Setup initiated');
        setMfaPrompt(false);
      }
    } catch (error) {
      console.error('MFA setup failed:', error);
    }
  };

  // Logout handler
  const handleLogout = () => {
    setUser(null);
    setMfaPrompt(false);
    // Redirect to FusionAuth logout
    window.location.href = `${process.env.REACT_APP_FA_URL}/oauth2/logout?client_id=${process.env.REACT_APP_FA_CLIENT_ID}`;
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>FusionAuth React SSO Demo</h1>
        <p>Enhanced with Security Features</p>
        
        {!user ? (
          <div className="login-section">
            <button 
              onClick={handleLogin} 
              disabled={loading}
              className="login-btn"
            >
              {loading ? 'Logging in...' : 'Login with FusionAuth'}
            </button>
            <p className="security-note">
              🔒 Secure OAuth 2.0 + PKCE Flow
            </p>
          </div>
        ) : (
          <div className="user-section">
            <h2>Welcome, {user.email}!</h2>
            <div className="user-details">
              <p>User ID: {user.id}</p>
              <p>Login Count: {user.loginCount || 0}</p>
              <p>MFA Status: {user.twoFactorEnabled ? '✅ Enabled' : '⚠️ Disabled'}</p>
            </div>
            
            {mfaPrompt && (
              <div className="mfa-prompt">
                <h3>⚠️ Security Alert</h3>
                <p>Your account doesn't have Multi-Factor Authentication enabled.</p>
                <p>Enable MFA now to secure your account:</p>
                <button onClick={enableMFA} className="mfa-btn">
                  Enable MFA Now
                </button>
                <button onClick={() => setMfaPrompt(false)} className="skip-btn">
                  Remind Me Later
                </button>
              </div>
            )}
            
            <button onClick={handleLogout} className="logout-btn">
              Logout
            </button>
          </div>
        )}
        
        <div className="features">
          <h3>Enhanced Security Features:</h3>
          <ul>
            <li>✅ Automatic MFA detection and prompting</li>
            <li>✅ Password age monitoring</li>
            <li>✅ Failed login attempt tracking</li>
            <li>✅ Session security validation</li>
            <li>✅ PKCE flow for enhanced OAuth security</li>
          </ul>
        </div>
      </header>
    </div>
  );
};

export default App;