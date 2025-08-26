const express = require('express');
const { FusionAuthClient } = require('@fusionauth/typescript-client');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// Configuration with air-gapped fallback support
const config = {
  apiKey: process.env.FUSIONAUTH_API_KEY || 'YOUR_API_KEY',
  fusionAuthUrl: process.env.FUSIONAUTH_URL || 'http://localhost:9011',
  applicationId: process.env.FUSIONAUTH_APP_ID || 'YOUR_APP_ID',
  isAirGapped: process.env.AIR_GAPPED === 'true',
  offlineMode: false
};

// Initialize FusionAuth client
const client = new FusionAuthClient(config.apiKey, config.fusionAuthUrl);

// Offline cache for air-gapped environments
const offlineCache = new Map();
const CACHE_FILE = path.join(__dirname, 'offline-cache.json');

// Load offline cache if exists
if (config.isAirGapped && fs.existsSync(CACHE_FILE)) {
  try {
    const cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    Object.entries(cacheData).forEach(([key, value]) => {
      offlineCache.set(key, value);
    });
    console.log('Loaded offline cache for air-gapped mode');
  } catch (error) {
    console.error('Failed to load offline cache:', error);
  }
}

// Health check endpoint with connectivity test
app.get('/health', async (req, res) => {
  try {
    // Try to reach FusionAuth
    const systemStatus = await client.retrieveSystemStatus();
    res.json({
      status: 'online',
      fusionAuth: 'connected',
      version: systemStatus.response.version,
      airGapped: config.isAirGapped,
      cacheSize: offlineCache.size
    });
  } catch (error) {
    // Fallback to offline mode
    config.offlineMode = true;
    res.json({
      status: 'offline',
      fusionAuth: 'disconnected',
      airGapped: config.isAirGapped,
      fallbackMode: true,
      cacheSize: offlineCache.size
    });
  }
});

// Enhanced registration endpoint with air-gapped support
app.post('/register', async (req, res) => {
  try {
    const { email, password, firstName, lastName, mobilePhone } = req.body;
    
    // Validate input
    if (!email || !password) {
      return res.status(400).json({ 
        error: 'Email and password are required' 
      });
    }

    // Generate secure user ID
    const userId = crypto.randomUUID();

    // Air-gapped mode: Store locally
    if (config.isAirGapped && config.offlineMode) {
      const user = {
        id: userId,
        email,
        firstName,
        lastName,
        mobilePhone,
        passwordHash: crypto.createHash('sha256').update(password).digest('hex'),
        insertInstant: new Date().toISOString(),
        verified: false,
        active: true
      };
      
      offlineCache.set(email, user);
      saveOfflineCache();
      
      return res.json({
        success: true,
        user,
        mode: 'offline',
        message: 'User registered in offline cache. Will sync when connection restored.'
      });
    }

    // Online mode: Register with FusionAuth
    const response = await client.register(userId, {
      user: {
        email,
        password,
        firstName,
        lastName,
        mobilePhone,
        twoFactorEnabled: false // Will prompt after first login
      },
      registration: {
        applicationId: config.applicationId,
        roles: ['user'],
        preferredLanguages: ['en']
      },
      sendSetPasswordEmail: false,
      skipRegistrationVerification: false
    });

    // Cache for offline fallback
    if (config.isAirGapped) {
      offlineCache.set(email, response.response.user);
      saveOfflineCache();
    }

    res.json({
      success: true,
      user: response.response.user,
      token: response.response.token,
      mode: 'online'
    });

  } catch (error) {
    console.error('Registration error:', error);
    
    // Try offline registration if FusionAuth is unavailable
    if (error.message && error.message.includes('ECONNREFUSED')) {
      config.offlineMode = true;
      // Recursively call with offline mode enabled
      return app._router.handle(req, res);
    }
    
    res.status(500).json({ 
      error: error.message || 'Registration failed',
      offlineAvailable: config.isAirGapped
    });
  }
});

// Login endpoint with offline support
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Offline mode: Check local cache
    if (config.isAirGapped && config.offlineMode) {
      const user = offlineCache.get(email);
      if (user) {
        const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
        if (user.passwordHash === passwordHash) {
          // Generate mock JWT for offline mode
          const token = crypto.randomBytes(32).toString('hex');
          return res.json({
            success: true,
            user,
            token,
            mode: 'offline',
            message: 'Authenticated using offline cache'
          });
        }
      }
      return res.status(401).json({ error: 'Invalid credentials (offline mode)' });
    }

    // Online mode: Authenticate with FusionAuth
    const response = await client.login({
      loginId: email,
      password,
      applicationId: config.applicationId
    });

    // Check for MFA requirement
    if (response.response.twoFactorRequired) {
      return res.json({
        twoFactorRequired: true,
        twoFactorId: response.response.twoFactorId,
        methods: response.response.methods
      });
    }

    res.json({
      success: true,
      user: response.response.user,
      token: response.response.token,
      refreshToken: response.response.refreshToken,
      mode: 'online'
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(401).json({ 
      error: 'Authentication failed',
      offlineAvailable: config.isAirGapped 
    });
  }
});

// Two-factor authentication endpoint
app.post('/two-factor', async (req, res) => {
  try {
    const { twoFactorId, code } = req.body;

    const response = await client.twoFactorLogin({
      twoFactorId,
      code,
      applicationId: config.applicationId
    });

    res.json({
      success: true,
      user: response.response.user,
      token: response.response.token
    });

  } catch (error) {
    res.status(401).json({ error: 'Invalid two-factor code' });
  }
});

// Verify JWT token
app.post('/verify', async (req, res) => {
  try {
    const { token } = req.body;

    // Offline mode: Basic validation
    if (config.isAirGapped && config.offlineMode) {
      // In production, implement proper JWT validation
      return res.json({
        valid: token && token.length > 0,
        mode: 'offline',
        warning: 'Limited validation in offline mode'
      });
    }

    // Online mode: Verify with FusionAuth
    const response = await client.retrieveUserUsingJWT(token);
    
    res.json({
      valid: true,
      user: response.response.user,
      mode: 'online'
    });

  } catch (error) {
    res.status(401).json({ 
      valid: false, 
      error: 'Invalid token' 
    });
  }
});

// Sync offline cache with FusionAuth when connection restored
app.post('/sync-offline-cache', async (req, res) => {
  if (!config.isAirGapped) {
    return res.status(400).json({ error: 'Not in air-gapped mode' });
  }

  const syncResults = {
    synced: [],
    failed: [],
    total: offlineCache.size
  };

  for (const [email, user] of offlineCache.entries()) {
    try {
      // Skip if user was created online
      if (!user.passwordHash) continue;

      // Register user with FusionAuth
      await client.register(user.id, {
        user: {
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          mobilePhone: user.mobilePhone
        },
        registration: {
          applicationId: config.applicationId
        }
      });

      syncResults.synced.push(email);
    } catch (error) {
      syncResults.failed.push({ email, error: error.message });
    }
  }

  res.json(syncResults);
});

// Password reset endpoint
app.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    const response = await client.forgotPassword({
      loginId: email,
      sendForgotPasswordEmail: true
    });

    res.json({
      success: true,
      message: 'Password reset email sent',
      changePasswordId: response.response.changePasswordId
    });

  } catch (error) {
    res.status(500).json({ error: 'Password reset failed' });
  }
});

// User profile update
app.put('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const updates = req.body;

    const response = await client.patchUser(userId, {
      user: updates
    });

    res.json({
      success: true,
      user: response.response.user
    });

  } catch (error) {
    res.status(500).json({ error: 'Profile update failed' });
  }
});

// Enable MFA for user
app.post('/user/:userId/enable-mfa', async (req, res) => {
  try {
    const { userId } = req.params;
    const { method } = req.body; // 'authenticator' or 'sms'

    const secret = crypto.randomBytes(20).toString('hex');
    
    const response = await client.enableTwoFactor(userId, {
      method,
      secret,
      // Additional configuration for SMS
      ...(method === 'sms' && { mobilePhone: req.body.mobilePhone })
    });

    res.json({
      success: true,
      qrCode: response.response.qrCode,
      secret: response.response.secret,
      recoveryCodes: response.response.recoveryCodes
    });

  } catch (error) {
    res.status(500).json({ error: 'MFA setup failed' });
  }
});

// Helper function to save offline cache
function saveOfflineCache() {
  if (config.isAirGapped) {
    const cacheData = {};
    offlineCache.forEach((value, key) => {
      cacheData[key] = value;
    });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2));
  }
}

// Error handler middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
    offlineMode: config.offlineMode
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FusionAuth Node.js Quickstart running on port ${PORT}`);
  console.log(`Air-gapped mode: ${config.isAirGapped}`);
  console.log(`FusionAuth URL: ${config.fusionAuthUrl}`);
  if (config.isAirGapped) {
    console.log('Note: Running with air-gapped support. Offline fallback available.');
  }
});

module.exports = app;