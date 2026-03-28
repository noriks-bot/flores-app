# FLORES APP MEGA UPGRADE

You are editing a Node.js app with 2 files: server.js (backend) + index.html (frontend SPA).
Login page is separate: login.html. The app uses better-sqlite3 for DB.

## CURRENT STATE
- META_TOKEN = old token from dash.noriks.com
- Auth: hardcoded `USERS = { noriks: 'noriks' }` with session cookies
- Navigation: sidebar with sections (ads-manager, optimizer, base-report, creative-reporting, origin-report, ai-hints, upload)

## TASK OVERVIEW

### 1. REPLACE META TOKEN with Dominik's Flores App Token

In server.js, replace the META_TOKEN constant value with:
```
EAASl5P6z0UYBRJrZCHWVQvMLmwwDu5jzdA5NEdl9t5K4ogCgH5Pi7acEEKhKSf5LYQKQcx9vd6S7euJRJWeICdZCHsVtUyQfVbF4lxAU25t9sRONxjhVZCBAv0nAnQJ7qiszzZBCR75JHzMXfSACfhxApcZBB0tMRngZAZBXQ3c0c4VeZC8OU6ltFc9YaCydW8Vg
```

Also add these new constants near the top:
```javascript
const FB_APP_ID = '1308302851166534';
const FB_APP_SECRET = '055332aa992f885134cf9cb6cd3ce5cf';
const NORIKS_PAGE_ID = '104695358812961';
const NORIKS_PAGE_TOKEN = 'EAASl5P6z0UYBRBeMx5auFDmvdkLwZCm8AZAsaVWqcNvyTFZAZBggUFybXpimvtfceKJIjPijA0prRvgWBILLBtdANqShzEmf8PxVCR9Dg5ZACR8Xsx2ucpO19HNktZCbSCK68rd7shT4ZC1SCZC3WkTNuJysHRqvfHlHuF1WdB5Sd2TNB5fAGvVOfnNNZCFE2ZCPWXJRIaiOAZD';
```

### 2. ADD SIDEBAR NAV ITEMS

In the sidebar navigation in index.html, add these new items:

After the Upload nav item (under "Data" section label), add:
```html
<a class="nav-item" data-section="bulk-uploader" onclick="navigateTo('bulk-uploader')">
  <i class="fas fa-layer-group"></i><span class="nav-item-text">Bulk Uploader</span>
</a>
```

Add a new section label "Admin" at the bottom of nav, with:
```html
<div class="nav-section-label">Admin</div>
<a class="nav-item" data-section="fb-integration" onclick="navigateTo('fb-integration')">
  <i class="fab fa-facebook"></i><span class="nav-item-text">FB Integration</span>
</a>
<a class="nav-item" data-section="users" onclick="navigateTo('users')">
  <i class="fas fa-users"></i><span class="nav-item-text">Users</span>
</a>
<a class="nav-item" data-section="settings" onclick="navigateTo('settings')">
  <i class="fas fa-cog"></i><span class="nav-item-text">Settings</span>
</a>
```

Also add these section names to the navigateTo section title map (look for the object mapping section IDs to titles).

### 3. BULK UPLOADER PAGE (section-bulk-uploader)

Create a full bulk campaign uploader interface. The form should let users define multiple campaigns to create on Facebook.

**Per campaign row fields:**
- Campaign Name (auto-generated from template: `cc:COUNTRY | TYPE | sku:PRODUCT | date: DD.MM.YYYY`)
- Ad Account (dropdown: top_noriks_2 / top_noriks_4)
- Country (dropdown: HR, CZ, PL, GR, SK, IT, HU)  
- Product (dropdown: shirts, boxers, starter, kompleti)
- Campaign Type (dropdown: CBO, ABO)
- Daily Budget EUR (number)
- Objective (dropdown: OUTCOME_SALES default, OUTCOME_LEADS, OUTCOME_TRAFFIC)
- Age Min/Max (25/55 defaults)
- Gender (dropdown: Male=1, Female=2, All=[1,2])
- Image URL (text input for creative)
- Landing Page URL (text)
- Primary Text (textarea)
- Headline (text)
- CTA (dropdown: SHOP_NOW default, LEARN_MORE, SIGN_UP)

**UI Features:**
- Card-based row design matching Flores style
- "Add Campaign" button, "Duplicate Row" button per row, "Remove" X button
- Summary bar: X campaigns, total budget €XXX
- "Create All Campaigns" big button with confirmation modal
- Progress indicator during creation
- Results table showing created campaign IDs or errors
- All campaigns created as PAUSED

**Backend endpoint: POST /api/bulk-create-campaigns**
Accepts array of campaign configs. For each:
1. Create Campaign on the selected ad account
2. Create Adset with targeting  
3. Create Creative using NORIKS_PAGE_ID + NORIKS_PAGE_TOKEN
4. Create Ad linking creative to adset
Returns results array. 1s delay between campaigns.

Ad accounts map: `{ 'top_noriks_2': 'act_1922887421998222', 'top_noriks_4': 'act_1426869489183439' }`

### 4. FB INTEGRATION PAGE (section-fb-integration)

Show Facebook integration status:
- Connected App info (App ID, name)
- Token status (valid/expired check via /me endpoint)
- List of accessible Ad Accounts with names, IDs, currency, timezone
- List of accessible Pages with names, IDs, permissions
- "Refresh" button to re-check

**Backend endpoints:**
- GET /api/fb-status → returns { app_id, token_valid, token_expires, user_name }
- GET /api/fb-accounts → returns list of ad accounts
- GET /api/fb-pages → returns list of pages with permissions

### 5. USERS PAGE (section-users)

Replace the hardcoded USERS object with SQLite-based user management.

**Database table: flores_users**
```sql
CREATE TABLE IF NOT EXISTS flores_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT DEFAULT 'viewer',
  display_name TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_login TEXT
);
```

**Roles:** admin, advertiser, viewer
- admin: full access to everything
- advertiser: can use bulk uploader + view reports
- viewer: read-only reports

**Seed default admin:** username=noriks, password=noriks, role=admin

**UI:**
- Table of users with username, display name, role, last login
- "Add User" form (username, password, display name, role dropdown)
- Edit/Delete buttons per user
- Current user can't delete themselves

**Backend endpoints:**
- GET /api/users → list users (admin only)
- POST /api/users → create user (admin only)
- PUT /api/users/:id → update user (admin only)
- DELETE /api/users/:id → delete user (admin only)

**Update login flow:** Check flores_users table instead of USERS object. Update last_login on successful login. Store user role in session.

### 6. SETTINGS PAGE (section-settings)

Simple settings page:
- **Meta API Token** field (masked, with reveal toggle) - shows current token, allows update
- **App ID** display
- **Default Ad Account** dropdown
- **Default Country** dropdown
- **Default Daily Budget** number
- Save button that persists to a settings table in SQLite

**Backend:**
- GET /api/settings → get settings
- POST /api/settings → update settings (admin only)

## CRITICAL RULES
- DO NOT modify the existing Upload section (#upload) functionality AT ALL
- DO NOT break any existing API routes or functionality
- Match the EXACT same visual style (dark navy sidebar, blue gradients, card design)
- All new API routes must be INSIDE the auth check (after line ~1080)
- Use the existing Database import (better-sqlite3) that's already at the top
- The adset API endpoint is: POST https://graph.facebook.com/v21.0/{AD_ACCOUNT_ID}/adsets (NOT campaign-id!)
- Campaign budget is in CENTS (multiply EUR by 100)
- Keep error handling robust - show user-friendly errors
