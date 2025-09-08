// index.js
require('dotenv').config();

const express = require('express');
const Database = require('better-sqlite3');

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType
} = require('discord.js');

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  PORT = 3000
} = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Please set DISCORD_TOKEN, CLIENT_ID and GUILD_ID in .env');
  process.exit(1);
}

// ---------- Database ----------
const db = new Database('accounts.sqlite');
db.pragma('foreign_keys = ON');

// Base tables
db.exec(`
CREATE TABLE IF NOT EXISTS maps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- legacy columns:
  name TEXT COLLATE NOCASE,
  map_id INTEGER NOT NULL,
  data TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE CASCADE
);
`);

// Migrate: add modern columns if missing
function hasColumn(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === column);
}
if (!hasColumn('accounts', 'login')) db.exec(`ALTER TABLE accounts ADD COLUMN login TEXT`);
if (!hasColumn('accounts', 'password')) db.exec(`ALTER TABLE accounts ADD COLUMN password TEXT`);
if (!hasColumn('accounts', 'label')) db.exec(`ALTER TABLE accounts ADD COLUMN label TEXT`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_login_map ON accounts(login, map_id) WHERE login IS NOT NULL;`);

function createMap(name) {
  const stmt = db.prepare('INSERT INTO maps (name) VALUES (?)');
  return stmt.run(name.trim());
}
function deleteMapById(id) {
  const stmt = db.prepare('DELETE FROM maps WHERE id = ?');
  return stmt.run(id);
}
function getMapByName(name) {
  const stmt = db.prepare('SELECT * FROM maps WHERE name = ?');
  return stmt.get(name.trim());
}
function getMapById(id) {
  const stmt = db.prepare('SELECT * FROM maps WHERE id = ?');
  return stmt.get(id);
}
function listMapsWithCounts() {
  const stmt = db.prepare(`
    SELECT m.id, m.name, m.created_at, COUNT(a.id) AS account_count
    FROM maps m
    LEFT JOIN accounts a ON a.map_id = m.id
    GROUP BY m.id
    ORDER BY m.name ASC
  `);
  return stmt.all();
}

function parsePair(pair) {
  const s = String(pair || '').trim();
  const idx = s.indexOf(':');
  if (idx <= 0) throw new Error('Use format USERNAME_OR_EMAIL:PASSWORD');
  const login = s.slice(0, idx).trim();
  const password = s.slice(idx + 1).trim();
  if (!login || !password) throw new Error('Both login and password are required');
  return { login, password };
}

function addAccountToMap({ mapId, login, password, label }) {
  const stmt = db.prepare(`
    INSERT INTO accounts (login, password, label, map_id, name, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  // Keep legacy "name" synchronized (for older views) and clear "data"
  return stmt.run(login, password, label || null, mapId, label || login, null);
}

function addAccountPairToMap({ mapId, pair, label }) {
  const { login, password } = parsePair(pair);
  return addAccountToMap({ mapId, login, password, label });
}

function bulkAddPairs({ mapId, pairsText }) {
  const lines = String(pairsText || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  const results = { added: 0, duplicates: 0, errors: [] };
  const tx = db.transaction(() => {
    for (const line of lines) {
      try {
        const { login, password } = parsePair(line);
        addAccountToMap({ mapId, login, password, label: null });
        results.added++;
      } catch (e) {
        if (String(e.message).includes('UNIQUE') || String(e.message).includes('constraint')) {
          results.duplicates++;
        } else {
          results.errors.push({ line, error: e.message });
        }
      }
    }
  });
  tx();
  return results;
}

function listAccountsByMapId(mapId, limit = 250) {
  const stmt = db.prepare(`
    SELECT id,
      COALESCE(label, login, name) AS label,
      login,
      password,
      created_at
    FROM accounts
    WHERE map_id = ?
    ORDER BY label ASC
    LIMIT ?
  `);
  return stmt.all(mapId, limit);
}
function removeAccountByLogin({ mapId, login }) {
  const stmt = db.prepare('DELETE FROM accounts WHERE map_id = ? AND login = ?');
  return stmt.run(mapId, login.trim());
}
function removeAccountById({ id }) {
  const stmt = db.prepare('DELETE FROM accounts WHERE id = ?');
  return stmt.run(id);
}
function getAccountById(id) {
  const stmt = db.prepare(`
    SELECT id, COALESCE(label, login, name) AS label, login, password, map_id, created_at
    FROM accounts WHERE id = ?
  `);
  return stmt.get(id);
}

function truncate(str, max) {
  if (!str) return str;
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}
function mask(pwd) {
  const s = String(pwd || '');
  if (!s) return '—';
  const len = Math.max(6, Math.min(10, s.length));
  return '•'.repeat(len);
}

// ---------- Discord Bot: Panel UX ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Open the Account Maps control panel')
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );
  console.log('✅ Slash command /panel registered to guild', GUILD_ID);
}

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`Web UI: http://localhost:${PORT}`);
});

function mainPanel() {
  const embed = new EmbedBuilder()
    .setTitle('Account Maps Panel')
    .setDescription('Manage maps and accounts with clicks. All actions are ephemeral.')
    .setColor(0x2B7FFF)
    .addFields(
      { name: 'Maps', value: '• List • Create • Delete', inline: false },
      { name: 'Accounts', value: '• Add (user:pass) • Bulk add • Remove • List', inline: false }
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('maps:list').setLabel('List Maps').setStyle(ButtonStyle.Primary).setEmoji('🗺️'),
    new ButtonBuilder().setCustomId('map:create').setLabel('Create Map').setStyle(ButtonStyle.Success).setEmoji('➕'),
    new ButtonBuilder().setCustomId('map:delete').setLabel('Delete Map').setStyle(ButtonStyle.Danger).setEmoji('🗑️')
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('acc:add').setLabel('Add Account').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId('acc:bulk').setLabel('Bulk Add').setStyle(ButtonStyle.Primary).setEmoji('📥'),
    new ButtonBuilder().setCustomId('acc:remove').setLabel('Remove Account').setStyle(ButtonStyle.Secondary).setEmoji('➖'),
    new ButtonBuilder().setCustomId('acc:list').setLabel('List Accounts').setStyle(ButtonStyle.Primary).setEmoji('📄')
  );

  return { embeds: [embed], components: [row1, row2] };
}

function mapsEmbed(maps) {
  return new EmbedBuilder()
    .setTitle('Maps')
    .setColor(0x2B7FFF)
    .setDescription(
      maps.length
        ? maps.map(m => `• ${m.name} (${m.account_count})`).join('\n').slice(0, 4000)
        : 'No maps yet. Click "Create Map".'
    );
}

function accountsEmbed(map, accounts) {
  return new EmbedBuilder()
    .setTitle(`Accounts in ${map.name}`)
    .setColor(0x49C26F)
    .setDescription(
      accounts.length
        ? accounts.map(a => `• ${a.label} — ${a.login} — ${mask(a.password)}`).join('\n').slice(0, 4000)
        : `No accounts in "${map.name}".`
    );
}

function backRow(extraButtons = []) {
  return new ActionRowBuilder().addComponents(
    ...extraButtons,
    new ButtonBuilder().setCustomId('panel:home').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
  );
}

function buildMapSelect(customId, placeholder, maps) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder);
  const options = maps.slice(0, 25).map(m => ({
    label: m.name.slice(0, 100),
    description: `${m.account_count} accounts`,
    value: String(m.id)
  }));
  if (options.length === 0) {
    menu.setOptions([{ label: 'No maps found', description: 'Create a map first', value: 'none', default: true }]);
  } else {
    menu.setOptions(options);
  }
  return new ActionRowBuilder().addComponents(menu);
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
      return interaction.reply({ ...mainPanel(), ephemeral: true });
    }

    // Buttons
    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id === 'panel:home') return interaction.update({ ...mainPanel() });

      // Maps
      if (id === 'maps:list') {
        const maps = listMapsWithCounts();
        return interaction.update({ embeds: [mapsEmbed(maps)], components: [backRow([
          new ButtonBuilder().setCustomId('maps:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary).setEmoji('🔄')
        ])]});
      }
      if (id === 'maps:refresh') {
        const maps = listMapsWithCounts();
        return interaction.update({ embeds: [mapsEmbed(maps)], components: [backRow([
          new ButtonBuilder().setCustomId('maps:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary).setEmoji('🔄')
        ])]});
      }
      if (id === 'map:create') {
        const modal = new ModalBuilder().setCustomId('map:create:modal').setTitle('Create Map');
        const nameInput = new TextInputBuilder()
          .setCustomId('map_name')
          .setLabel('Map name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(64);
        modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
        return interaction.showModal(modal);
      }
      if (id === 'map:delete') {
        const maps = listMapsWithCounts();
        const embed = new EmbedBuilder().setTitle('Delete Map').setDescription('Select a map to delete (all accounts removed).').setColor(0xE5534B);
        const selectRow = buildMapSelect('maps:delete:select', 'Choose a map to delete…', maps);
        return interaction.update({ embeds: [embed], components: [selectRow, backRow()] });
      }

      // Accounts - add (choose map first)
      if (id === 'acc:add') {
        const maps = listMapsWithCounts();
        const embed = new EmbedBuilder().setTitle('Add Account').setDescription('Select a map to add an account to.').setColor(0x49C26F);
        const selectRow = buildMapSelect('acc:add:select', 'Choose a map…', maps);
        return interaction.update({ embeds: [embed], components: [selectRow, backRow()] });
      }

      // Accounts - bulk add (choose map first)
      if (id === 'acc:bulk') {
        const maps = listMapsWithCounts();
        const embed = new EmbedBuilder().setTitle('Bulk Add Accounts').setDescription('Select a map to add multiple accounts.').setColor(0x49C26F);
        const selectRow = buildMapSelect('acc:bulk:select', 'Choose a map…', maps);
        return interaction.update({ embeds: [embed], components: [selectRow, backRow()] });
      }

      // Accounts - remove (choose map first)
      if (id === 'acc:remove') {
        const maps = listMapsWithCounts();
        const embed = new EmbedBuilder().setTitle('Remove Account').setDescription('Select a map, then enter the login to remove.').setColor(0xE0A235);
        const selectRow = buildMapSelect('acc:remove:select', 'Choose a map…', maps);
        return interaction.update({ embeds: [embed], components: [selectRow, backRow()] });
      }

      // Accounts - list
      if (id === 'acc:list') {
        const maps = listMapsWithCounts();
        const embed = new EmbedBuilder().setTitle('List Accounts').setDescription('Select a map to view accounts.').setColor(0x49C26F);
        const selectRow = buildMapSelect('maps:accounts:select', 'Choose a map…', maps);
        return interaction.update({ embeds: [embed], components: [selectRow, backRow()] });
      }

      // Reveal password (ephemeral)
      if (id.startsWith('acc:reveal:')) {
        const accountId = Number(id.split(':').pop());
        const acc = getAccountById(accountId);
        if (!acc) return interaction.reply({ content: 'Account not found.', ephemeral: true });
        return interaction.reply({ content: `Password for ${acc.login}:\n\`\`\`\n${acc.password}\n\`\`\``, ephemeral: true });
      }

      // Delete by ID (from detail view)
      if (id.startsWith('acc:delete:')) {
        const accountId = Number(id.split(':').pop());
        const acc = getAccountById(accountId);
        if (!acc) return interaction.update({ content: 'Already deleted.', embeds: [], components: [backRow()] });
        removeAccountById({ id: accountId });
        return interaction.update({ content: `🗑️ Deleted account "${acc.login}".`, embeds: [], components: [backRow()] });
      }
    }

    // Select menus
    if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;
      const value = interaction.values?.[0];

      if (id === 'maps:delete:select') {
        if (value === 'none') return interaction.update({ content: 'No maps to delete.', embeds: [], components: [backRow()] });
        const map = getMapById(Number(value));
        if (!map) return interaction.update({ content: 'Map not found.', embeds: [], components: [backRow()] });
        deleteMapById(map.id);
        return interaction.update({ content: `🗑️ Deleted map "${map.name}" and all accounts.`, embeds: [], components: [backRow()] });
      }

      // Add (after choosing map, show modal)
      if (id === 'acc:add:select') {
        if (value === 'none') return interaction.update({ content: 'No maps found.', embeds: [], components: [backRow()] });
        const map = getMapById(Number(value));
        if (!map) return interaction.update({ content: 'Map not found.', embeds: [], components: [backRow()] });

        const modal = new ModalBuilder().setCustomId(`acc:add:modal:${map.id}`).setTitle(`Add to ${map.name}`);
        const pair = new TextInputBuilder()
          .setCustomId('pair')
          .setLabel('Login:Password (e.g., user@mail.com:pass123)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(200);
        const label = new TextInputBuilder()
          .setCustomId('label')
          .setLabel('Label (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(64);
        modal.addComponents(new ActionRowBuilder().addComponents(pair), new ActionRowBuilder().addComponents(label));
        return interaction.showModal(modal);
      }

      // Bulk add modal
      if (id === 'acc:bulk:select') {
        if (value === 'none') return interaction.update({ content: 'No maps found.', embeds: [], components: [backRow()] });
        const map = getMapById(Number(value));
        if (!map) return interaction.update({ content: 'Map not found.', embeds: [], components: [backRow()] });

        const modal = new ModalBuilder().setCustomId(`acc:bulk:modal:${map.id}`).setTitle(`Bulk Add to ${map.name}`);
        const pairs = new TextInputBuilder()
          .setCustomId('pairs')
          .setLabel('One per line: login:password')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(3500);
        modal.addComponents(new ActionRowBuilder().addComponents(pairs));
        return interaction.showModal(modal);
      }

      // Remove modal: ask for login
      if (id === 'acc:remove:select') {
        if (value === 'none') return interaction.update({ content: 'No maps found.', embeds: [], components: [backRow()] });
        const map = getMapById(Number(value));
        if (!map) return interaction.update({ content: 'Map not found.', embeds: [], components: [backRow()] });

        const modal = new ModalBuilder().setCustomId(`acc:remove:modal:${map.id}`).setTitle(`Remove from ${map.name}`);
        const loginInput = new TextInputBuilder()
          .setCustomId('login')
          .setLabel('Login (exact)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(200);
        modal.addComponents(new ActionRowBuilder().addComponents(loginInput));
        return interaction.showModal(modal);
      }

      // List accounts -> choose map -> show list + selector for details
      if (id === 'maps:accounts:select') {
        if (value === 'none') return interaction.update({ content: 'No maps found.', embeds: [], components: [backRow()] });
        const map = getMapById(Number(value));
        if (!map) return interaction.update({ content: 'Map not found.', embeds: [], components: [backRow()] });
        const accounts = listAccountsByMapId(map.id, 100);
        const embed = accountsEmbed(map, accounts);
        const sel = new StringSelectMenuBuilder()
          .setCustomId(`acc:detail:select:${map.id}`)
          .setPlaceholder('Open account details…')
          .setOptions(
            accounts.slice(0, 25).map(a => ({
              label: truncate(a.label || a.login, 100),
              description: truncate(a.login, 100),
              value: String(a.id)
            }))
          );
        const detailRow = new ActionRowBuilder().addComponents(sel);
        return interaction.update({ embeds: [embed], components: [detailRow, backRow()] });
      }

      // Open account detail
      if (id.startsWith('acc:detail:select:')) {
        const accountId = Number(value);
        const acc = getAccountById(accountId);
        if (!acc) return interaction.update({ content: 'Account not found.', embeds: [], components: [backRow()] });
        const map = getMapById(acc.map_id);
        const embed = new EmbedBuilder()
          .setTitle(`Account: ${acc.label || acc.login}`)
          .setColor(0x6F7AE3)
          .addFields(
            { name: 'Map', value: map?.name || '—', inline: true },
            { name: 'Login', value: acc.login, inline: false },
            { name: 'Password', value: mask(acc.password), inline: false }
          )
          .setTimestamp(new Date(acc.created_at));
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`acc:reveal:${acc.id}`).setLabel('Reveal Password').setStyle(ButtonStyle.Primary).setEmoji('👁️'),
          new ButtonBuilder().setCustomId(`acc:delete:${acc.id}`).setLabel('Delete').setStyle(ButtonStyle.Danger).setEmoji('🗑️')
        );
        return interaction.update({ embeds: [embed], components: [row, backRow()] });
      }
    }

    // Modals
    if (interaction.type === InteractionType.ModalSubmit) {
      const id = interaction.customId;

      if (id === 'map:create:modal') {
        const name = interaction.fields.getTextInputValue('map_name').trim();
        if (!name) return interaction.reply({ content: 'Map name is required.', ephemeral: true });
        try {
          createMap(name);
          return interaction.reply({ content: `🗺️ Map "${name}" created.`, ephemeral: true });
        } catch (e) {
          if (String(e.message).includes('UNIQUE')) {
            return interaction.reply({ content: `Map "${name}" already exists.`, ephemeral: true });
          }
          return interaction.reply({ content: `Error: ${e.message}`, ephemeral: true });
        }
      }

      if (id.startsWith('acc:add:modal:')) {
        const mapId = Number(id.split(':').pop());
        const pair = interaction.fields.getTextInputValue('pair').trim();
        const label = (interaction.fields.getTextInputValue('label') || '').trim() || null;
        try {
          addAccountPairToMap({ mapId, pair, label });
          return interaction.reply({ content: `✅ Added to map.`, ephemeral: true });
        } catch (e) {
          if (String(e.message).includes('UNIQUE')) {
            return interaction.reply({ content: `Duplicate: that login already exists in this map.`, ephemeral: true });
          }
          return interaction.reply({ content: `Error: ${e.message}`, ephemeral: true });
        }
      }

      if (id.startsWith('acc:bulk:modal:')) {
        const mapId = Number(id.split(':').pop());
        const pairsText = interaction.fields.getTextInputValue('pairs');
        try {
          const res = bulkAddPairs({ mapId, pairsText });
          const msg =
            `📥 Bulk add result:\n` +
            `• Added: ${res.added}\n` +
            `• Duplicates: ${res.duplicates}\n` +
            (res.errors.length ? `• Errors: ${res.errors.length}` : '');
          return interaction.reply({ content: msg, ephemeral: true });
        } catch (e) {
          return interaction.reply({ content: `Error: ${e.message}`, ephemeral: true });
        }
      }

      if (id.startsWith('acc:remove:modal:')) {
        const mapId = Number(id.split(':').pop());
        const login = interaction.fields.getTextInputValue('login').trim();
        try {
          const res = removeAccountByLogin({ mapId, login });
          if (res.changes === 0) return interaction.reply({ content: `Not found: ${login}`, ephemeral: true });
          return interaction.reply({ content: `🗑️ Removed: ${login}`, ephemeral: true });
        } catch (e) {
          return interaction.reply({ content: `Error: ${e.message}`, ephemeral: true });
        }
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: 'Unexpected error.', ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: 'Unexpected error.', ephemeral: true }).catch(() => {});
    }
  }
});

// ---------- Web UI (polished + animated) ----------
const app = express();
app.use(express.urlencoded({ extended: true }));

function escapeHTML(str = '') {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

app.get('/', (req, res) => {
  const maps = listMapsWithCounts();
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Account Maps</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root {
      --bg1: #0f2027;
      --bg2: #203a43;
      --bg3: #2c5364;
      --glass: rgba(255,255,255,.08);
      --border: rgba(255,255,255,.15);
      --text: #e9eef3;
      --muted: #9fb2c0;
      --accent: #65d6ff;
      --danger: #ff6b6b;
      --ok: #52d27d;
    }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      color: var(--text);
      background: linear-gradient(120deg, var(--bg1), var(--bg2), var(--bg3));
      background-size: 200% 200%;
      animation: moveBg 12s ease-in-out infinite;
    }
    @keyframes moveBg {
      0% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }
    .container { max-width: 1100px; margin: 48px auto; padding: 0 20px; }
    .heading { display:flex; align-items:center; justify-content:space-between; margin-bottom: 24px; }
    h1 { margin: 0; font-weight: 700; letter-spacing: .3px; }
    .grid { display: grid; grid-template-columns: 2fr 1fr; gap: 20px; }
    .card {
      background: var(--glass);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 18px;
      backdrop-filter: blur(8px);
      box-shadow: 0 8px 30px rgba(0,0,0,.25);
    }
    .map { display:flex; justify-content:space-between; align-items:center; padding: 10px 0; border-bottom: 1px dashed rgba(255,255,255,.1); }
    .map:last-child { border-bottom: none; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    button, .btn {
      cursor: pointer; border: 1px solid var(--border); border-radius:10px;
      background: rgba(255,255,255,.06); color: var(--text);
      padding: 8px 12px; transition: .2s transform, .2s background, .2s border;
    }
    button:hover, .btn:hover { transform: translateY(-1px); background: rgba(255,255,255,.12); }
    input[type=text] {
      width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border);
      background: rgba(255,255,255,.06); color: var(--text); outline: none;
    }
    .muted { color: var(--muted); }
    .row { display:flex; gap: 10px; align-items:center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="heading">
      <h1>Account Maps</h1>
      <a class="btn" href="https://discord.com/channels/@me" target="_blank">Open Discord</a>
    </div>

    <div class="grid">
      <div class="card">
        <h2>All Maps (${maps.length})</h2>
        ${maps.length ? maps.map(m => `
          <div class="map">
            <div>
              <a href="/map/${m.id}">${escapeHTML(m.name)}</a>
              <span class="muted">(${m.account_count} accounts)</span>
            </div>
            <form method="POST" action="/map/${m.id}/delete" onsubmit="return confirm('Delete "${escapeHTML(m.name)}" and all accounts?');">
              <button>Delete</button>
            </form>
          </div>
        `).join('') : '<p class="muted">No maps yet.</p>'}
      </div>

      <div class="card">
        <h2>Create Map</h2>
        <form method="POST" action="/map">
          <input type="text" name="name" placeholder="Map name" required>
          <div style="height:10px"></div>
          <button>Create</button>
        </form>
        <p class="muted" style="margin-top:12px">Tip: Don’t store sensitive passwords in plain text unless you add auth & encryption.</p>
      </div>
    </div>
  </div>
</body>
</html>`);
});

app.post('/map', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.redirect('/');
  try { createMap(name); } catch (_) {}
  res.redirect('/');
});

app.get('/map/:id', (req, res) => {
  const map = getMapById(req.params.id);
  if (!map) return res.status(404).send('Map not found');
  const accounts = listAccountsByMapId(map.id, 500);

  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Map: ${escapeHTML(map.name)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    /* Shared theme (same as home) */
    :root {
      --bg1: #0f2027; --bg2: #203a43; --bg3: #2c5364;
      --glass: rgba(255,255,255,.08); --border: rgba(255,255,255,.15);
      --text: #e9eef3; --muted: #9fb2c0; --accent: #65d6ff; --danger: #ff6b6b; --ok: #52d27d;
    }
    html, body { height:100%; margin:0; }
    body {
      font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      color: var(--text);
      background: linear-gradient(120deg, var(--bg1), var(--bg2), var(--bg3));
      background-size: 200% 200%;
      animation: moveBg 12s ease-in-out infinite;
    }
    @keyframes moveBg {
      0% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }
    .container { max-width: 1200px; margin: 48px auto; padding: 0 20px; }
    .heading { display:flex; align-items:center; justify-content:space-between; margin-bottom: 24px; }
    h1 { margin: 0; font-weight: 700; letter-spacing: .3px; }
    .grid { display: grid; grid-template-columns: 1.6fr 1fr; gap: 20px; }
    .card {
      background: var(--glass);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 18px;
      backdrop-filter: blur(8px);
      box-shadow: 0 8px 30px rgba(0,0,0,.25);
    }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px 8px; border-bottom: 1px dashed rgba(255,255,255,.12); text-align:left; vertical-align: top; }
    th { color: var(--muted); font-weight: 600; }
    .actions { display: flex; gap: 8px; }
    button, .btn {
      cursor: pointer; border: 1px solid var(--border); border-radius:10px;
      background: rgba(255,255,255,.06); color: var(--text);
      padding: 8px 12px; transition: .2s transform, .2s background, .2s border;
    }
    button:hover, .btn:hover { transform: translateY(-1px); background: rgba(255,255,255,.12); }
    input[type=text], textarea {
      width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border);
      background: rgba(255,255,255,.06); color: var(--text); outline: none;
    }
    .muted { color: var(--muted); }
    .row { display:flex; gap: 10px; align-items:center; }
    .pill { display:inline-block; padding:4px 8px; background:rgba(255,255,255,.06); border:1px solid var(--border); border-radius:999px; font-size:12px; color: var(--muted); }
    .pw { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  </style>
</head>
<body>
  <div class="container">
    <div class="heading">
      <div class="row">
        <a class="btn" href="/">&larr; Back</a>
        <h1 style="margin-left:8px">Map: ${escapeHTML(map.name)}</h1>
      </div>
      <span class="pill">${accounts.length} accounts</span>
    </div>

    <div class="grid">
      <div class="card">
        <h2>Accounts</h2>
        ${accounts.length === 0 ? '<p class="muted">No accounts yet.</p>' : `
          <table>
            <thead><tr><th>Label</th><th>Login</th><th>Password</th><th>Actions</th></tr></thead>
            <tbody>
              ${accounts.map(a => `
                <tr>
                  <td>${escapeHTML(a.label || a.login)}</td>
                  <td>${escapeHTML(a.login || '')}</td>
                  <td class="pw"><span id="pw-${a.id}">••••••••</span></td>
                  <td class="actions">
                    <button onclick="reveal(${a.id})">Reveal</button>
                    <button onclick="copyLogin('${escapeHTML(a.login || '')}')">Copy login</button>
                    <form method="POST" action="/map/${map.id}/account/${a.id}/delete" style="display:inline" onsubmit="return confirm('Delete this account?');">
                      <button style="border-color: rgba(255,0,0,.35); color:#ffd6d6;">Delete</button>
                    </form>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `}
      </div>

      <div class="card">
        <h2>Add Accounts</h2>
        <p class="muted">Use the simple format: <b>login:password</b></p>
        <form method="POST" action="/map/${map.id}/account">
          <label>Single pair<br><input type="text" name="pair" placeholder="user@mail.com:pass123" required></label>
          <div style="height:8px"></div>
          <label>Label (optional)<br><input type="text" name="label" placeholder="Friendly name"></label>
          <div style="height:10px"></div>
          <button>Add</button>
        </form>

        <div style="height:20px"></div>
        <h3>Bulk add</h3>
        <form method="POST" action="/map/${map.id}/account/bulk">
          <label>One per line<br>
            <textarea name="pairs" rows="8" placeholder="first@mail.com:pass1\nsecond@mail.com:pass2"></textarea>
          </label>
          <div style="height:10px"></div>
          <button>Bulk Add</button>
        </form>
        <p class="muted" style="margin-top:12px">Passwords are shown masked by default. Click Reveal to view or copy.</p>
      </div>
    </div>
  </div>

  <script>
    async function reveal(id) {
      const el = document.getElementById('pw-' + id);
      if (!el) return;
      el.textContent = '…';
      try {
        const r = await fetch('/api/account/' + id);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        el.textContent = d.password || '—';
      } catch (e) {
        el.textContent = 'error';
        alert('Failed to reveal password: ' + e.message);
      }
    }
    async function copyLogin(text) {
      try { await navigator.clipboard.writeText(text); alert('Login copied'); }
      catch { alert('Copy failed'); }
    }
  </script>
</body>
</html>`);
});

app.post('/map/:id/account', (req, res) => {
  const map = getMapById(req.params.id);
  if (!map) return res.status(404).send('Map not found');
  const pair = String(req.body.pair || '').trim();
  const label = String(req.body.label || '').trim() || null;
  if (!pair) return res.redirect(`/map/${map.id}`);
  try {
    addAccountPairToMap({ mapId: map.id, pair, label });
  } catch (_) {}
  res.redirect(`/map/${map.id}`);
});

app.post('/map/:id/account/bulk', (req, res) => {
  const map = getMapById(req.params.id);
  if (!map) return res.status(404).send('Map not found');
  const pairs = String(req.body.pairs || '');
  try {
    bulkAddPairs({ mapId: map.id, pairsText: pairs });
  } catch (_) {}
  res.redirect(`/map/${map.id}`);
});

app.post('/map/:id/delete', (req, res) => {
  deleteMapById(req.params.id);
  res.redirect('/');
});

app.post('/map/:mapId/account/:accountId/delete', (req, res) => {
  removeAccountById({ id: req.params.accountId });
  res.redirect(`/map/${req.params.mapId}`);
});

// Minimal API to reveal password on demand (avoid embedding plaintext in HTML)
app.get('/api/account/:id', (req, res) => {
  const row = db.prepare('SELECT id, login, password FROM accounts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

// Bind to localhost only
app.listen(PORT, '127.0.0.1', () => {
  console.log(`🌐 Web UI running at http://localhost:${PORT}`);
});

// ---------- Boot ----------
(async () => {
  try {
    await registerCommands();
    await client.login(DISCORD_TOKEN);
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
})();