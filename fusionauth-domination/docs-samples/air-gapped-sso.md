# Air-Gapped SSO Deployment Guide for FusionAuth

## Overview

Deploying FusionAuth in air-gapped (offline) environments presents unique challenges for organizations operating in highly regulated industries, remote locations, or secure facilities. This guide provides comprehensive instructions for implementing Single Sign-On (SSO) in environments without internet connectivity.

## Use Cases

- **Maritime Operations**: Cruise ships and cargo vessels with intermittent connectivity
- **Military Installations**: Secure facilities requiring complete network isolation
- **Industrial Sites**: Oil rigs, mining operations, remote manufacturing plants
- **Healthcare**: Hospitals with strict HIPAA compliance requiring network segmentation
- **Financial Services**: Trading floors with regulatory air-gap requirements

## Prerequisites

Before beginning the air-gapped deployment:

1. **Download Offline Bundle** (perform on internet-connected machine):
```bash
# Download FusionAuth Docker images
docker pull fusionauth/fusionauth-app:latest
docker pull postgres:12

# Save images to tar files
docker save fusionauth/fusionauth-app:latest > fusionauth-app.tar
docker save postgres:12 > postgres.tar

# Download required dependencies
curl -O https://files.fusionauth.io/offline/fusionauth-offline-bundle.zip
```

2. **Transfer Files** to air-gapped environment via:
   - USB drive (encrypted)
   - Secure file transfer through DMZ
   - Physical media (DVD/Blu-ray)

## Installation Steps

### Step 1: Load Docker Images

```bash
# On air-gapped system
docker load < fusionauth-app.tar
docker load < postgres.tar
```

### Step 2: Configure Docker Compose

Create `docker-compose.yml`:

```yaml
version: '3'
services:
  db:
    image: postgres:12
    environment:
      POSTGRES_USER: fusionauth
      POSTGRES_PASSWORD: ChangeMeToSecurePassword
      POSTGRES_DB: fusionauth
    volumes:
      - db_data:/var/lib/postgresql/data
    networks:
      - fusionauth_network
    restart: always

  fusionauth:
    image: fusionauth/fusionauth-app:latest
    depends_on:
      - db
    environment:
      DATABASE_URL: jdbc:postgresql://db:5432/fusionauth
      DATABASE_USERNAME: fusionauth
      DATABASE_PASSWORD: ChangeMeToSecurePassword
      FUSIONAUTH_MEMORY: 512M
      SEARCH_TYPE: database
      FUSIONAUTH_URL: http://fusionauth:9011
    ports:
      - "9011:9011"
    volumes:
      - fusionauth_config:/usr/local/fusionauth/config
      - ./offline-keys:/usr/local/fusionauth/keys
    networks:
      - fusionauth_network
    restart: always

networks:
  fusionauth_network:
    driver: bridge

volumes:
  db_data:
  fusionauth_config:
```

### Step 3: Initialize Configuration

```bash
# Start services
docker-compose up -d

# Wait for initialization
sleep 30

# Access at http://localhost:9011
```

## SAML Configuration for Air-Gapped SSO

### Configure SAML Identity Provider

1. **Generate Certificates** (offline):
```bash
# Generate private key
openssl genrsa -out saml_private.key 2048

# Generate certificate
openssl req -new -x509 -key saml_private.key -out saml_cert.crt -days 3650 \
  -subj "/C=US/ST=State/L=City/O=Organization/CN=fusionauth.local"
```

2. **Configure SAML Settings**:
```json
{
  "identityProvider": {
    "name": "Air-Gapped SAML Provider",
    "entityId": "https://fusionauth.local/saml",
    "ssoEndpoint": "https://fusionauth.local/samlv2/sso",
    "certificate": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
    "signRequest": true,
    "verifySignature": true
  }
}
```

### Offline User Synchronization

Implement batch user synchronization for periodic updates:

```python
import json
import hashlib
from datetime import datetime

class OfflineUserSync:
    def __init__(self, export_path):
        self.export_path = export_path
        
    def export_users(self, users):
        """Export users for offline import"""
        export_data = {
            "timestamp": datetime.utcnow().isoformat(),
            "checksum": "",
            "users": []
        }
        
        for user in users:
            export_data["users"].append({
                "email": user["email"],
                "username": user.get("username"),
                "firstName": user.get("firstName"),
                "lastName": user.get("lastName"),
                "roles": user.get("roles", []),
                "groups": user.get("groups", [])
            })
        
        # Add integrity checksum
        data_str = json.dumps(export_data["users"], sort_keys=True)
        export_data["checksum"] = hashlib.sha256(data_str.encode()).hexdigest()
        
        with open(f"{self.export_path}/users_export.json", "w") as f:
            json.dump(export_data, f, indent=2)
    
    def import_users(self, import_file):
        """Import users in offline environment"""
        with open(import_file, "r") as f:
            import_data = json.load(f)
        
        # Verify integrity
        data_str = json.dumps(import_data["users"], sort_keys=True)
        checksum = hashlib.sha256(data_str.encode()).hexdigest()
        
        if checksum != import_data["checksum"]:
            raise ValueError("Data integrity check failed")
        
        return import_data["users"]
```

## Session Management in Offline Mode

### Local Session Store

Implement Redis for offline session management:

```javascript
const redis = require('redis');
const session = require('express-session');
const RedisStore = require('connect-redis')(session);

// Create Redis client for offline session storage
const redisClient = redis.createClient({
  host: 'localhost',
  port: 6379,
  db: 0,
  retry_strategy: (options) => {
    // Offline retry strategy
    if (options.total_retry_time > 1000 * 60 * 60) {
      return new Error('Retry time exhausted');
    }
    return Math.min(options.attempt * 100, 3000);
  }
});

// Session configuration
app.use(session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 // 24 hours
  }
}));
```

## Monitoring and Maintenance

### Health Checks

Implement comprehensive health checks for air-gapped deployments:

```bash
#!/bin/bash
# health_check.sh

# Check FusionAuth service
curl -f http://localhost:9011/api/status || exit 1

# Check database connectivity
docker exec fusionauth_db_1 pg_isready -U fusionauth || exit 1

# Check disk space
DISK_USAGE=$(df /var/lib/docker | awk 'NR==2 {print $5}' | sed 's/%//')
if [ $DISK_USAGE -gt 80 ]; then
  echo "Warning: Disk usage above 80%"
  exit 1
fi

# Check certificate expiration
openssl x509 -checkend 2592000 -noout -in /path/to/saml_cert.crt
if [ $? -eq 1 ]; then
  echo "Warning: Certificate expires within 30 days"
fi
```

### Backup Strategy

```bash
#!/bin/bash
# backup.sh

BACKUP_DIR="/secure/backups"
DATE=$(date +%Y%m%d_%H%M%S)

# Backup database
docker exec fusionauth_db_1 pg_dump -U fusionauth fusionauth | \
  gzip > "$BACKUP_DIR/fusionauth_db_$DATE.sql.gz"

# Backup configuration
tar -czf "$BACKUP_DIR/fusionauth_config_$DATE.tar.gz" \
  /var/lib/docker/volumes/fusionauth_config

# Backup encryption keys
tar -czf "$BACKUP_DIR/fusionauth_keys_$DATE.tar.gz" \
  /usr/local/fusionauth/keys

# Maintain only last 30 backups
find "$BACKUP_DIR" -name "fusionauth_*" -mtime +30 -delete
```

## Security Considerations

### Network Segmentation

```yaml
# network-policy.yaml for Kubernetes
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: fusionauth-airgap-policy
spec:
  podSelector:
    matchLabels:
      app: fusionauth
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: authorized-app
    ports:
    - protocol: TCP
      port: 9011
  egress:
  - to:
    - podSelector:
        matchLabels:
          app: postgres
    ports:
    - protocol: TCP
      port: 5432
```

### Audit Logging

Enable comprehensive audit logging for compliance:

```json
{
  "auditLogConfiguration": {
    "enabled": true,
    "retentionDays": 365,
    "events": {
      "user.login": true,
      "user.logout": true,
      "user.create": true,
      "user.update": true,
      "user.delete": true,
      "jwt.generate": true,
      "jwt.refresh": true
    },
    "output": {
      "type": "file",
      "path": "/secure/audit/fusionauth-audit.log",
      "rotate": true,
      "compress": true
    }
  }
}
```

## Troubleshooting

### Common Issues and Solutions

| Issue | Cause | Solution |
|-------|-------|----------|
| Login failures | Clock drift | Sync time using local NTP server |
| Session timeout | Redis memory full | Increase Redis maxmemory setting |
| SAML errors | Certificate mismatch | Verify certificate fingerprints |
| Performance degradation | Database bloat | Run PostgreSQL VACUUM |
| Token validation fails | Key rotation | Ensure all nodes have updated keys |

### Debug Mode

Enable debug logging for troubleshooting:

```bash
# Set environment variables
export FUSIONAUTH_APP_LOG_LEVEL=debug
export FUSIONAUTH_AUDIT_LOG_LEVEL=debug

# Restart FusionAuth
docker-compose restart fusionauth

# View logs
docker-compose logs -f fusionauth | grep -E "ERROR|WARN|DEBUG"
```

## Conclusion

Deploying FusionAuth in air-gapped environments requires careful planning but provides robust authentication and SSO capabilities for organizations with strict security requirements. Regular maintenance, monitoring, and security updates through controlled processes ensure continued reliability and compliance.

For additional support with air-gapped deployments, consult the FusionAuth enterprise support team or engage professional services for customized implementation assistance.