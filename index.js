// .env dosyasını oku (Railway Variables varsa onlar öncelikli)
try {
  require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((l) => {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch {}

const {
  Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, PermissionFlagsBits,
  MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  ChannelType, ActivityType, ButtonBuilder, ButtonStyle, AttachmentBuilder,
  UserSelectMenuBuilder, StringSelectMenuBuilder, AuditLogEvent,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const { joinVoiceChannel, VoiceConnectionStatus, entersState, getVoiceConnection } = require('@discordjs/voice');

// ---- Basit veri kaydı (db.json) ----
const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dir, { recursive: true });
const dbFile = path.join(dir, 'db.json');
let data = { mesai: [], aktif: {}, destek: {}, bans: [], olusumlar: [], meta: {} };
try { data = { ...data, ...JSON.parse(fs.readFileSync(dbFile, 'utf8')) }; } catch {}
function save() {
  const tmp = dbFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, dbFile);
}

const BOT_ADI = 'Fest Gun';
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID; // doluysa komutlar anında görünür
const MESAI_KANAL_ID = process.env.MESAI_KANAL_ID || '1554566189391552554';
const KURUCU_ID = process.env.KURUCU_ID || null; // sunucu sahibi dışında panel açabilecek ekstra kişi (opsiyonel)
const BAN_LOG_KANAL_ID = process.env.BAN_LOG_KANAL_ID || '1542872504291561634';
const UYARI_LOG_KANAL_ID = process.env.UYARI_LOG_KANAL_ID || '1542872591042216096'; // yetkili uyarı logları
const BAN_LIMIT = 5; // en fazla biriken ban hakkı (her saat 1 hak yenilenir)
const KOMUT_ROL_ID = process.env.KOMUT_ROL_ID || '1542872257276149860'; // botu sadece bu rol kullanabilir
const UYE_ROL_ID = process.env.UYE_ROL_ID || '1542925356984565962'; // /member ile verilecek rol
// Bu rollere sahip kişilere uyarı verilemez. Birden fazla ise virgülle ayır. Kapatmak için Railway'de UYARI_KORUMALI_ROL_ID=yok yaz.
const KORUMALI_ROLLER = (process.env.UYARI_KORUMALI_ROL_ID || '1542925356984565962').split(',').map((x) => x.trim()).filter((x) => x && x.toLowerCase() !== 'yok');
const SUPER_UYARI_ROL_ID = process.env.SUPER_UYARI_ROL_ID || '1542874337546338386'; // bu rol herkese uyarı verebilir (rütbe ve korumalı rol sınırı yok)
const superUyarici = (member) => !!member?.roles?.cache?.has(SUPER_UYARI_ROL_ID);
const uyariIslemi = (i) => (i.isChatInputCommand() && i.commandName === 'yetkili') || (!i.isChatInputCommand() && typeof i.customId === 'string' && i.customId.startsWith('uyari_'));
const UYARI_MAX = 5; // 5. uyarıda ban
// logo.png yoksa bot çökmesin, logosuz çalışsın
const LOGO_YOLU = path.join(__dirname, 'logo.png');
const LOGO_VAR = fs.existsSync(LOGO_YOLU);
const logoDosyalari = () => (LOGO_VAR ? [new AttachmentBuilder(LOGO_YOLU, { name: 'logo.png' })] : []);
const SES_KANAL_ID = process.env.SES_KANAL_ID || '1542872463870922814';

if (!TOKEN) {
  console.error('DISCORD_TOKEN ortam değişkeni tanımlı değil!');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildModeration],
});

/* ------------------------- Yardımcılar ------------------------- */
const TZ = 3 * 3600e3; // Türkiye UTC+3
const dayStart = (t) => { const s = t + TZ; return s - (s % 86400000) - TZ; };
const weekStart = (t) => {
  const d = dayStart(t);
  const dow = new Date(d + TZ).getUTCDay();
  return d - ((dow + 6) % 7) * 86400000; // Pazartesi 00:00
};
const fmtDur = (ms) => {
  const m = Math.floor(ms / 60000);
  return `${Math.floor(m / 60)}s ${m % 60}dk`;
};
const fmtDate = (t) => new Date(t).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });

function totals(from, to) {
  const m = {};
  const add = (u, s, e) => {
    const a = Math.max(s, from), b = Math.min(e, to);
    if (b > a) m[u] = (m[u] || 0) + (b - a);
  };
  for (const x of data.mesai) add(x.u, x.s, x.e);
  const now = Date.now();
  for (const [u, s] of Object.entries(data.aktif)) add(u, s, now);
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}

function tabloEmbed(baslik, list, aciklama) {
  const medals = ['🥇', '🥈', '🥉'];
  const satirlar = list.slice(0, 20).map(([u, ms], i) => `${medals[i] || `**${i + 1}.**`} <@${u}> — \`${fmtDur(ms)}\``);
  return new EmbedBuilder()
    .setTitle(baslik)
    .setColor(0x5865f2)
    .setDescription((aciklama ? aciklama + '\n\n' : '') + (satirlar.join('\n') || '*Kayıt bulunamadı.*'))
    .setTimestamp();
}

const hata = (i, msg) => i.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });

/* ------------------------- Komutlar ------------------------- */
const commands = [
  new SlashCommandBuilder().setName('sunucu').setDescription('Sunucu durum duyurusu')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('durum').setDescription('Sunucu durumunu duyur')
      .addStringOption((o) => o.setName('durum').setDescription('Sunucu durumu').setRequired(true)
        .addChoices(
          { name: 'Aktif', value: 'aktif' },
          { name: 'Restart Atılıyor', value: 'restart' },
          { name: 'Kapalı / Bakım', value: 'kapali' },
        ))
      .addStringOption((o) => o.setName('ip').setDescription('Sunucu IP adresi').setRequired(true))),

  new SlashCommandBuilder().setName('ban').setDescription('Ban paneli (sadece kurucu açabilir)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) => s.setName('panel').setDescription('Ban / yasak kaldırma panelini aç')),

  new SlashCommandBuilder().setName('ban-sorgu').setDescription('Kullanıcının ban durumunu sorgula')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption((o) => o.setName('id').setDescription('Kullanıcı ID').setRequired(true)),

  new SlashCommandBuilder().setName('kick').setDescription('Kullanıcıyı at')
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption((o) => o.setName('kullanıcı').setDescription('Atılacak kişi').setRequired(true))
    .addStringOption((o) => o.setName('sebep').setDescription('Sebep')),

  new SlashCommandBuilder().setName('rolver').setDescription('Kullanıcıya rol ver')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addUserOption((o) => o.setName('kullanıcı').setDescription('Kişi').setRequired(true))
    .addRoleOption((o) => o.setName('rol').setDescription('Rol').setRequired(true)),

  new SlashCommandBuilder().setName('rolal').setDescription('Kullanıcıdan rol al')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addUserOption((o) => o.setName('kullanıcı').setDescription('Kişi').setRequired(true))
    .addRoleOption((o) => o.setName('rol').setDescription('Rol').setRequired(true)),

  new SlashCommandBuilder().setName('istatistik-bilgi').setDescription('Sunucu istatistiklerini göster'),

  new SlashCommandBuilder().setName('destek-islem').setDescription('Destek işlem takibi')
    .addSubcommand((s) => s.setName('top').setDescription('En çok destek işlemi yapan yetkililer'))
    .addSubcommand((s) => s.setName('ekle').setDescription('Yetkiliye destek işlemi ekle (yetkili komutu)')
      .addUserOption((o) => o.setName('yetkili').setDescription('Yetkili').setRequired(true))
      .addIntegerOption((o) => o.setName('adet').setDescription('Eklenecek adet (varsayılan 1)').setMinValue(1).setMaxValue(100))
      .addStringOption((o) => o.setName('not').setDescription('Not')))
    .addSubcommand((s) => s.setName('istatistik').setDescription('Bir yetkilinin destek istatistiği')
      .addUserOption((o) => o.setName('yetkili').setDescription('Yetkili (boşsa sen)'))),

  new SlashCommandBuilder().setName('mesai').setDescription('Mesai sistemi')
    .addSubcommand((s) => s.setName('gir').setDescription('Mesaiye gir'))
    .addSubcommand((s) => s.setName('çık').setDescription('Mesaiden çık'))
    .addSubcommand((s) => s.setName('tablo').setDescription('Haftalık mesai tablosu'))
    .addSubcommand((s) => s.setName('sıralama').setDescription('Bugünün en aktif kişileri')),

  new SlashCommandBuilder().setName('yetkili').setDescription('Yetkili işlemleri')
    .addSubcommandGroup((g) => g.setName('uyarı').setDescription('Yetkili uyarı sistemi')
      .addSubcommand((s) => s.setName('paneli').setDescription('Yetkili uyarı panelini aç'))),

  new SlashCommandBuilder().setName('member').setDescription('Hiçbir rolü olmayan herkese otomatik üye rolü ver (sadece kurucu)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('dmduyuru').setDescription('Sunucudaki herkese DM duyurusu gönder')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((c) => c.toJSON());

/* ------------------------- Hazır ------------------------- */
async function korumaKontrol() {
  try {
    for (const g of client.guilds.cache.values()) {
      await g.members.fetch().catch(() => {});
      const sr = g.roles.cache.get(SUPER_UYARI_ROL_ID);
      if (sr) console.log(`⭐ Süper uyarı rolü: "${sr.name}" — ${sr.members.size} üye (herkese uyarı verebilir).`);
      else console.warn(`⚠️ Süper uyarı rolü bulunamadı (${SUPER_UYARI_ROL_ID}).`);
      for (const id of KORUMALI_ROLLER) {
        const r = g.roles.cache.get(id);
        if (id === g.id) console.warn(`⚠️ Korumalı rol ID'si @everyone (sunucu ID'si) — herkes korunmuş olur! UYARI_KORUMALI_ROL_ID'yi düzelt.`);
        else if (!r) console.warn(`⚠️ Korumalı rol bulunamadı (${id}). Bu sunucuda böyle bir rol yok, koruma çalışmaz.`);
        else {
          console.log(`🛡️ Uyarı korumalı rol: "${r.name}" — ${r.members.size}/${g.memberCount} üyede var.`);
          if (r.members.size > g.memberCount * 0.4) console.warn(`⚠️ "${r.name}" rolü üyelerin büyük kısmında var. Uyarı verilecek yetkililer de bu role sahipse hiçbirine uyarı verilemez!`);
        }
      }
    }
  } catch (e) { console.error('Koruma kontrolü hatası:', e.message); }
}

let hazirMi = false;
async function hazir() {
  if (hazirMi) return;
  hazirMi = true;
  console.log(`${BOT_ADI} giriş yaptı: ${client.user.tag}`);
  console.log('Bot şu sunucularda:', client.guilds.cache.map((g) => `${g.name} (${g.id})`).join(', ') || 'HİÇBİRİNDE DEĞİL');
  client.user.setPresence({ activities: [{ name: '/sunucu • /mesai', type: ActivityType.Watching }] });

  try {
    if (GUILD_ID) {
      if (!client.guilds.cache.has(GUILD_ID)) {
        console.error(`UYARI: Bot ${GUILD_ID} ID'li sunucuda değil! Botu sunucuya tekrar davet et (applications.commands izniyle).`);
      }
      await client.application.commands.set([]); // eski global komutları temizle (çift görünmesin)
      const r = await client.application.commands.set(commands, GUILD_ID);
      console.log(`✅ ${r.size} komut sunucuya kaydedildi.`);
    } else {
      const r = await client.application.commands.set(commands);
      console.log(`✅ ${r.size} komut global kaydedildi (görünmesi 1 saate kadar sürebilir).`);
    }
  } catch (e) {
    console.error('❌ Komut kayıt hatası:', e.code, e.message, JSON.stringify(e.rawError?.errors || {}));
  }

  korumaKontrol();
  banLogTest();
  sesKanalinaGir();
  haftalikKontrol();
  setInterval(haftalikKontrol, 60 * 1000);
}
client.once('clientReady', hazir);
client.once('ready', hazir);

/* ------------------------- Ses kanalında bekleme ------------------------- */
async function sesKanalinaGir() {
  try {
    const ch = await client.channels.fetch(SES_KANAL_ID);
    if (!ch || !ch.isVoiceBased()) return console.error('Ses kanalı bulunamadı:', SES_KANAL_ID);
    getVoiceConnection(ch.guild.id)?.destroy();
    const conn = joinVoiceChannel({
      channelId: ch.id,
      guildId: ch.guild.id,
      adapterCreator: ch.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: true,
    });
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        conn.destroy();
        setTimeout(sesKanalinaGir, 5000);
      }
    });
    console.log(`Ses kanalına girildi: ${ch.name}`);
  } catch (e) {
    console.error('Ses kanalına girme hatası:', e.message);
    setTimeout(sesKanalinaGir, 15000);
  }
}

/* ------------------------- Haftalık otomatik tablo ------------------------- */
async function haftalikKontrol() {
  try {
    const ws = weekStart(Date.now());
    if (!data.meta.lastWeek) { data.meta.lastWeek = ws; save(); return; }
    if (data.meta.lastWeek < ws) {
      const prev = data.meta.lastWeek;
      data.meta.lastWeek = ws; save();
      const ch = await client.channels.fetch(MESAI_KANAL_ID).catch(() => null);
      if (ch?.isTextBased()) {
        const list = totals(prev, ws);
        await ch.send({ embeds: [tabloEmbed('📊 Haftalık Mesai Tablosu', list, `${fmtDate(prev)} — ${fmtDate(ws)}`)] });
      }
    }
  } catch (e) { console.error('Haftalık kontrol hatası:', e); }
}

/* ------------------------- Etkileşimler ------------------------- */
client.on('interactionCreate', async (i) => {
  try {
    // Botu sadece belirlenen rol (ve sunucu sahibi) kullanabilir
    if (!i.guild) return;
    const izinli = i.user.id === i.guild.ownerId || (KURUCU_ID && i.user.id === KURUCU_ID) || i.member?.roles?.cache?.has(KOMUT_ROL_ID) || (superUyarici(i.member) && uyariIslemi(i));
    if (!izinli) {
      return await i.reply({ content: `⛔ Bu botu kullanmak için <@&${KOMUT_ROL_ID}> rolüne sahip olmalısın.`, flags: MessageFlags.Ephemeral });
    }
    if (!i.isChatInputCommand()) return await bilesenIslem(i);

    const sub = i.options.getSubcommand(false);
    console.log(`[KOMUT] /${i.commandName}${sub ? ' ' + sub : ''} — ${i.user.tag}`);

    switch (i.commandName) {
      case 'sunucu': {
        const durum = i.options.getString('durum');
        const ip = i.options.getString('ip');
        const map = {
          aktif: { renk: 0x2ecc71, baslik: '🟢 Sunucu Durumu — Aktif', aciklama: 'Sunucumuz **aktif**! Giriş yapabilirsiniz, iyi oyunlar dileriz.', durumText: '✅ **Aktif**',
            liste: ['Sunucuya IP adresi üzerinden bağlanabilirsiniz.', 'Sorun yaşarsanız destek talebi açabilirsiniz.', 'Duyuru kanalını takip etmeyi unutmayın.'] },
          restart: { renk: 0xf1c40f, baslik: '🟡 Sunucu Durumu — Restart', aciklama: 'Şu anda sunucumuza **restart** atılıyor, lütfen giriş sağlamayın. Restart birkaç dakika içerisinde tamamlanacaktır.', durumText: '⚠️ **Restart Atılıyor**',
            liste: ['Restart süresince sunucuya giriş denemeyiniz.', 'Restart sonrası sorun yaşarsanız destek talebi açabilirsiniz.', 'Duyuru kanalını takip ederek restartın bitişinden haberdar olabilirsiniz.'] },
          kapali: { renk: 0xe74c3c, baslik: '🔴 Sunucu Durumu — Kapalı', aciklama: 'Sunucumuz şu anda **kapalı / bakımdadır**.', durumText: '⛔ **Kapalı**',
            liste: ['Açıldığında duyuru yapılacaktır.', 'Lütfen duyuru kanalını takip edin.'] },
        }[durum];

        const embed = new EmbedBuilder()
          .setColor(map.renk)
          .setTitle(map.baslik)
          .setDescription(`> ${map.aciklama}`)
          .addFields(
            { name: 'Bilgilendirme', value: map.liste.map((x) => `• ${x}`).join('\n') },
            { name: 'Sunucu Bilgileri', value: `• **Sunucu Durumu:** ${map.durumText}\n• **Sunucu IP Adresi:**\n\`\`\`${ip}\`\`\`` },
          )
          .setFooter({ text: `${BOT_ADI} Moderation` })
          .setTimestamp();
        if (LOGO_VAR) embed.setThumbnail('attachment://logo.png');
        return await i.reply({ embeds: [embed], files: logoDosyalari() });
      }

      case 'ban': {
        const kurucu = i.user.id === i.guild.ownerId || (KURUCU_ID && i.user.id === KURUCU_ID);
        if (!kurucu) return await hata(i, 'Bu paneli sadece sunucu kurucusu açabilir.');
        return await i.reply({ ...panelMesaji(), files: logoDosyalari() });
      }

      case 'ban-sorgu': {
        const id = i.options.getString('id').trim();
        const ban = await i.guild.bans.fetch(id).catch(() => null);
        const kayitlar = data.bans.filter((b) => b.id === id).slice(-5);
        const embed = new EmbedBuilder().setColor(ban ? 0xe74c3c : 0x2ecc71).setTitle('🔎 Ban Sorgu')
          .addFields(
            { name: 'ID', value: id },
            { name: 'Durum', value: ban ? `🔴 **Banlı**\nSebep: ${ban.reason || 'Belirtilmemiş'}` : '🟢 Banlı değil' },
          );
        if (kayitlar.length) embed.addFields({ name: 'Bot Ban Geçmişi', value: kayitlar.map((b) => `• ${fmtDate(b.t)} — <@${b.yetkili}> — ${b.sebep}`).join('\n') });
        return await i.reply({ embeds: [embed] });
      }

      case 'kick': {
        const user = i.options.getUser('kullanıcı');
        const sebep = i.options.getString('sebep') || 'Sebep belirtilmedi';
        const m = await i.guild.members.fetch(user.id).catch(() => null);
        if (!m) return await hata(i, 'Kullanıcı sunucuda değil.');
        if (!m.kickable) return await hata(i, 'Bu kullanıcıyı atamam (yetkim/rol sıram yetersiz).');
        await m.kick(`${i.user.tag}: ${sebep}`);
        return await i.reply({ embeds: [new EmbedBuilder().setColor(0xe67e22).setTitle('👢 Kullanıcı Atıldı')
          .addFields({ name: 'Kullanıcı', value: `${user.tag} (${user.id})` }, { name: 'Yetkili', value: `<@${i.user.id}>` }, { name: 'Sebep', value: sebep }).setTimestamp()] });
      }

      case 'rolver':
      case 'rolal': {
        const user = i.options.getUser('kullanıcı');
        const rol = i.options.getRole('rol');
        const m = await i.guild.members.fetch(user.id).catch(() => null);
        if (!m) return await hata(i, 'Kullanıcı sunucuda değil.');
        const me = i.guild.members.me;
        if (rol.position >= me.roles.highest.position || rol.managed) return await hata(i, 'Bu rolü yönetemem (rolüm bu rolden düşük ya da rol bot rolü).');
        if (i.member.id !== i.guild.ownerId && rol.position >= i.member.roles.highest.position) return await hata(i, 'Kendi rolünden yüksek/eşit rolü yönetemezsin.');
        if (i.commandName === 'rolver') await m.roles.add(rol); else await m.roles.remove(rol);
        return await i.reply({ embeds: [new EmbedBuilder().setColor(rol.color || 0x5865f2)
          .setDescription(`${i.commandName === 'rolver' ? '✅' : '➖'} <@${user.id}> kullanıcısına ${rol} rolü ${i.commandName === 'rolver' ? 'verildi' : 'alındı'}.`)] });
      }

      case 'member': {
        const kurucu = i.user.id === i.guild.ownerId || (KURUCU_ID && i.user.id === KURUCU_ID);
        if (!kurucu) return await hata(i, 'Bu komutu sadece sunucu kurucusu kullanabilir.');

        const rol = await i.guild.roles.fetch(UYE_ROL_ID).catch(() => null);
        if (!rol) return await hata(i, `Rol bulunamadı (${UYE_ROL_ID}).`);
        if (rol.managed || rol.position >= i.guild.members.me.roles.highest.position) {
          return await hata(i, 'Bu rolü veremem (botun rolü bu rolden düşük ya da rol bir bot/entegrasyon rolü).');
        }

        await i.deferReply();
        const tum = await i.guild.members.fetch();
        // roles.cache içinde @everyone her zaman vardır, yani size 1 = hiç rolü yok
        const hedefler = [...tum.values()].filter((x) => !x.user.bot && x.roles.cache.size <= 1);
        if (!hedefler.length) return await i.editReply('ℹ️ Hiçbir rolü olmayan kimse yok.');

        let ok = 0, fail = 0, n = 0;
        for (const x of hedefler) {
          try { await x.roles.add(rol, `/member — ${i.user.tag}`); ok++; } catch { fail++; }
          n++;
          if (n % 20 === 0) await i.editReply(`⏳ Roller veriliyor... ${n}/${hedefler.length}`).catch(() => {});
          await new Promise((r) => setTimeout(r, 400)); // rate limit koruması
        }

        return await i.editReply({ content: '', embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle('✅ Üye Rolleri Verildi')
          .setDescription(`Hiçbir rolü olmayan **${hedefler.length}** kişiden **${ok}** kişiye ${rol} rolü verildi.${fail ? `\n❌ Başarısız: **${fail}**` : ''}`)
          .addFields({ name: 'Yetkili', value: `<@${i.user.id}>`, inline: true }).setTimestamp()] });
      }

      case 'istatistik-bilgi': {
        await i.deferReply();
        const g = i.guild;
        await g.members.fetch().catch(() => {});
        const bots = g.members.cache.filter((m) => m.user.bot).size;
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`📈 ${g.name} — İstatistikler`)
          .addFields(
            { name: '👥 Üyeler', value: `Toplam: **${g.memberCount}**\nİnsan: **${g.memberCount - bots}** • Bot: **${bots}**`, inline: true },
            { name: '💬 Kanallar', value: `Yazı: **${g.channels.cache.filter((c) => c.type === ChannelType.GuildText).size}**\nSes: **${g.channels.cache.filter((c) => c.type === ChannelType.GuildVoice).size}**`, inline: true },
            { name: '🎭 Roller', value: `**${g.roles.cache.size}**`, inline: true },
            { name: '💎 Boost', value: `Seviye **${g.premiumTier}** • **${g.premiumSubscriptionCount || 0}** boost`, inline: true },
            { name: '🕒 Aktif Mesai', value: `**${Object.keys(data.aktif).length}** kişi`, inline: true },
            { name: '🔨 Bot Ban Kaydı', value: `**${data.bans.length}**`, inline: true },
            { name: '📅 Kuruluş', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:D>`, inline: true },
          ).setTimestamp();
        if (g.iconURL()) embed.setThumbnail(g.iconURL());
        return await i.editReply({ embeds: [embed] });
      }

      case 'destek-islem': {
        if (sub === 'ekle') {
          if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) return await hata(i, 'Bu komutu kullanmak için "Sunucuyu Yönet" yetkisi gerekir.');
          const y = i.options.getUser('yetkili');
          const adet = i.options.getInteger('adet') || 1;
          const not = i.options.getString('not');
          const k = (data.destek[y.id] ||= { toplam: 0, kayit: [] });
          k.toplam += adet;
          k.kayit.push({ t: Date.now(), adet, not, ekleyen: i.user.id });
          k.kayit = k.kayit.slice(-200);
          save();
          return await i.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle('🎫 Destek İşlemi Eklendi')
            .setDescription(`<@${y.id}> yetkilisine **${adet}** destek işlemi eklendi.\nToplam: **${k.toplam}**${not ? `\nNot: ${not}` : ''}`).setTimestamp()] });
        }
        if (sub === 'top') {
          const list = Object.entries(data.destek).sort((a, b) => b[1].toplam - a[1].toplam).slice(0, 15);
          const medals = ['🥇', '🥈', '🥉'];
          return await i.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🏆 Destek İşlem Sıralaması')
            .setDescription(list.map(([u, v], n) => `${medals[n] || `**${n + 1}.**`} <@${u}> — **${v.toplam}** işlem`).join('\n') || '*Kayıt yok.*').setTimestamp()] });
        }
        if (sub === 'istatistik') {
          const y = i.options.getUser('yetkili') || i.user;
          const k = data.destek[y.id];
          if (!k) return await i.reply({ content: `ℹ️ <@${y.id}> için destek işlem kaydı yok.`, flags: MessageFlags.Ephemeral });
          const haftaBasi = weekStart(Date.now());
          const hafta = k.kayit.filter((x) => x.t >= haftaBasi).reduce((a, b) => a + b.adet, 0);
          const son = k.kayit.slice(-5).reverse().map((x) => `• ${fmtDate(x.t)} — +${x.adet}${x.not ? ` (${x.not})` : ''}`).join('\n');
          return await i.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`🎫 ${y.username} — Destek İstatistiği`)
            .addFields({ name: 'Toplam', value: `**${k.toplam}**`, inline: true }, { name: 'Bu Hafta', value: `**${hafta}**`, inline: true }, { name: 'Son Kayıtlar', value: son || '-' }).setTimestamp()] });
        }
        break;
      }

      case 'mesai': {
        const uid = i.user.id;
        if (sub === 'gir') {
          if (data.aktif[uid]) return await hata(i, `Zaten mesaidesin (başlangıç: ${fmtDate(data.aktif[uid])}).`);
          data.aktif[uid] = Date.now(); save();
          return await i.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle('🟢 Mesaiye Girildi').setDescription(`<@${uid}> mesaiye girdi.\n🕒 ${fmtDate(data.aktif[uid])}`)] });
        }
        if (sub === 'çık') {
          const s = data.aktif[uid];
          if (!s) return await hata(i, 'Şu an mesaide değilsin.');
          const e = Date.now();
          data.mesai.push({ u: uid, s, e }); delete data.aktif[uid]; save();
          return await i.reply({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('🔴 Mesaiden Çıkıldı').setDescription(`<@${uid}> mesaiden çıktı.\n⏱️ Süre: **${fmtDur(e - s)}**`)] });
        }
        if (sub === 'tablo') {
          const ws = weekStart(Date.now());
          return await i.reply({ embeds: [tabloEmbed('📊 Haftalık Mesai Tablosu', totals(ws, Date.now() + 1), `Hafta başlangıcı: ${fmtDate(ws)}`)] });
        }
        if (sub === 'sıralama') {
          const ds = dayStart(Date.now());
          return await i.reply({ embeds: [tabloEmbed('🏅 Bugünün En Aktif Kişileri', totals(ds, Date.now() + 1), `Tarih: ${new Date().toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' })}`)] });
        }
        break;
      }

      case 'yetkili': {
        if (i.options.getSubcommandGroup(false) === 'uyarı' && sub === 'paneli') {
          return await i.reply(uyariPanelMesaji());
        }
        break;
      }

      case 'dmduyuru': {
        const modal = new ModalBuilder().setCustomId('dmduyuru_modal').setTitle('DM Duyurusu');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('baslik').setLabel('Başlık').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('mesaj').setLabel('Mesaj').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000)),
        );
        return await i.showModal(modal);
      }
    }
  } catch (e) {
    console.error(e);
    const payload = { content: `❌ Hata: ${e.message || 'Bilinmeyen hata'}`, flags: MessageFlags.Ephemeral };
    if (i.deferred || i.replied) i.followUp(payload).catch(() => {});
    else i.reply(payload).catch(() => {});
  }
});

/* ------------------------- DM Duyuru ------------------------- */
/* ------------------------- Ban Logu ------------------------- */
const panelBanlari = new Set(); // panelden atılan banlar (çift log olmasın)

async function banLogGonder(embed, kanalId = BAN_LOG_KANAL_ID) {
  try {
    const ch = await client.channels.fetch(kanalId);
    if (!ch || !ch.isTextBased()) return { ok: false, hata: 'Kanal bulunamadı ya da yazı kanalı değil' };
    await ch.send({ embeds: [embed] });
    return { ok: true };
  } catch (e) {
    const sebep = e.code === 10003 ? 'Kanal bulunamadı (ID yanlış ya da bot kanalı göremiyor)'
      : e.code === 50001 ? 'Botun bu kanalı görme yetkisi yok'
      : e.code === 50013 ? 'Botun bu kanala mesaj / embed gönderme yetkisi yok'
      : e.message;
    console.error('❌ Ban log gönderilemedi:', e.code, e.message);
    return { ok: false, hata: sebep };
  }
}

async function banLogTest() {
  const r = await banLogGonder(new EmbedBuilder().setColor(0x2ecc71).setDescription('✅ Ban log sistemi aktif. Banlar bu kanala yazılacak.'));
  console.log(r.ok ? '✅ Ban log kanalına test mesajı gönderildi.' : `❌ Ban log kanalına yazılamıyor: ${r.hata}`);
  const u = await banLogGonder(new EmbedBuilder().setColor(0xf39c12).setDescription('✅ Yetkili uyarı log sistemi aktif. Uyarılar bu kanala yazılacak.'), UYARI_LOG_KANAL_ID);
  console.log(u.ok ? '✅ Uyarı log kanalına test mesajı gönderildi.' : `❌ Uyarı log kanalına yazılamıyor: ${u.hata}`);
}

// Panel dışında (sağ tık, başka bot vs.) atılan banları da logla
client.on('guildBanAdd', async (ban) => {
  try {
    if (panelBanlari.has(ban.user.id)) return;
    await new Promise((r) => setTimeout(r, 1500));
    const b = ban.partial ? await ban.fetch().catch(() => ban) : ban;
    const logs = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 5 }).catch(() => null);
    const entry = logs?.entries.find((e) => e.target?.id === ban.user.id && Date.now() - e.createdTimestamp < 20000);
    const embed = new EmbedBuilder().setColor(0xe74c3c).setTitle('🔨 Kullanıcı Yasaklandı')
      .setThumbnail(ban.user.displayAvatarURL())
      .addFields(
        { name: 'Kullanıcı', value: `${ban.user.tag} (${ban.user.id})` },
        { name: 'Yetkili', value: entry?.executor ? `<@${entry.executor.id}>` : 'Bilinmiyor', inline: true },
        { name: 'Kaynak', value: 'Sunucu / Dışarıdan', inline: true },
        { name: 'Sebep', value: (b.reason || entry?.reason || 'Belirtilmedi').slice(0, 1000) },
      ).setTimestamp();
    banLogGonder(embed);
  } catch (e) { console.error('guildBanAdd hatası:', e.message); }
});

/* ------------------------- Ban Paneli ------------------------- */
const SAAT = 3600e3;
function banHakki() {
  const now = Date.now();
  let b = data.banHak;
  if (!b) b = data.banHak = { hak: BAN_LIMIT, son: now };
  if (b.hak >= BAN_LIMIT) { b.hak = BAN_LIMIT; b.son = now; }
  else {
    const n = Math.floor((now - b.son) / SAAT);
    if (n > 0) {
      b.hak = Math.min(BAN_LIMIT, b.hak + n);
      b.son = b.hak >= BAN_LIMIT ? now : b.son + n * SAAT;
    }
  }
  return { kalan: b.hak, acilis: b.hak < BAN_LIMIT ? b.son + SAAT : null };
}
function banHakKullan() {
  banHakki();
  data.banHak.hak = Math.max(0, data.banHak.hak - 1);
  save();
}

function panelMesaji() {
  const h = banHakki();
  const embed = new EmbedBuilder()
    .setColor(0x1e6fff)
    .setTitle('🔨 Fest Gun — Ban Paneli')
    .setDescription('Aşağıdaki menüden bir kişi seç, sebebini yaz ve yasakla.\nYasağı kaldırmak için **Yasak Kaldır** butonunu kullan.')
    .addFields(
      { name: '⏳ Ban Hakkı', value: `**${h.kalan}/${BAN_LIMIT}**${h.acilis ? `\nSıradaki hak <t:${Math.floor(h.acilis / 1000)}:R>` : ''}`, inline: true },
      { name: '📜 Kural', value: `Her saat **1** ban hakkı yenilenir (en fazla ${BAN_LIMIT}).`, inline: true },
    )
    .setFooter({ text: 'Fest Gun Moderation' })
    .setTimestamp();
  if (LOGO_VAR) embed.setThumbnail('attachment://logo.png');
  const satir1 = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId('ban_user').setPlaceholder('🎯 Banlanacak kişiyi seç...').setMinValues(1).setMaxValues(1),
  );
  const satir2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('unban_liste').setLabel('Yasak Kaldır').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('unban_id').setLabel('ID ile Yasak Kaldır').setEmoji('🔓').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [satir1, satir2] };
}

async function banKontrol(i, hedefId) {
  const h = banHakki();
  if (h.kalan <= 0) return `Ban hakkın kalmadı (0/${BAN_LIMIT}). Yeni hak <t:${Math.floor(h.acilis / 1000)}:R> yenilenecek.`;
  if (hedefId === i.user.id) return 'Kendini banlayamazsın.';
  if (hedefId === client.user.id) return 'Beni banlayamazsın.';
  if (hedefId === i.guild.ownerId || (KURUCU_ID && hedefId === KURUCU_ID)) return 'Kurucu banlanamaz.';
  const m = await i.guild.members.fetch(hedefId).catch(() => null);
  if (m && !m.bannable) return 'Bu kişiyi banlayamam (rolü benden üstte ya da yetkim yok).';
  return null;
}

/* ------------------------- Yetkili Uyarı Paneli ------------------------- */
function uyariPanelMesaji() {
  const embed = new EmbedBuilder()
    .setColor(0xf39c12)
    .setTitle('⚠️ Yetkili Uyarı Paneli')
    .setDescription('Aşağıdan bir yetkili seç, sebebini yaz ve uyarıyı ver.')
    .addFields(
      { name: '📈 Uyarı Basamakları', value: '`1x` → 1x Uyarı rolü\n`2x` → 2x Uyarı rolü\n`3x` → 3x Uyarı rolü\n`4x` → 4x Uyarı rolü\n`5x` → **Sunucudan BAN** 🔨' },
      { name: '📜 Kurallar', value: `Sadece **kendinden alt** roldeki kişilere uyarı verebilirsin.\nKorumalı role sahip kişilere uyarı verilemez.\n<@&${SUPER_UYARI_ROL_ID}> rolü bu sınırlardan muaftır, herkese uyarı verebilir.` },
    )
    .setFooter({ text: 'Fest Gun Moderation' })
    .setTimestamp();
  const satir = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId('uyari_user').setPlaceholder('⚠️ Uyarı verilecek yetkiliyi seç...').setMinValues(1).setMaxValues(1),
  );
  return { embeds: [embed], components: [satir] };
}

// 1x-4x uyarı rollerini bul, yoksa oluştur
async function uyariRolleri(guild) {
  const idler = (process.env.UYARI_ROLLERI || '').split(',').map((x) => x.trim()).filter(Boolean);
  const renkler = [0xf1c40f, 0xe67e22, 0xd35400, 0xe74c3c];
  const roller = [];
  for (let n = 1; n <= UYARI_MAX - 1; n++) {
    let r = idler[n - 1] ? guild.roles.cache.get(idler[n - 1]) : guild.roles.cache.find((x) => x.name === `${n}x Uyarı`);
    if (!r) r = await guild.roles.create({ name: `${n}x Uyarı`, color: renkler[n - 1], reason: 'Yetkili uyarı sistemi' });
    roller.push(r);
  }
  return roller;
}

async function uyariKontrol(i, hedefId) {
  if (hedefId === i.user.id) return { red: 'Kendine uyarı veremezsin.' };
  if (hedefId === client.user.id) return { red: 'Bana uyarı veremezsin.' };
  if (hedefId === i.guild.ownerId || (KURUCU_ID && hedefId === KURUCU_ID)) return { red: 'Kurucuya uyarı verilemez.' };
  const m = await i.guild.members.fetch(hedefId).catch(() => null);
  if (!m) return { red: 'Bu kişi sunucuda değil.' };
  if (m.user.bot) return { red: 'Botlara uyarı verilemez.' };
  const superMi = superUyarici(i.member);
  const korumaRol = superMi ? null : KORUMALI_ROLLER.find((id) => id !== i.guild.id && m.roles.cache.has(id));
  if (korumaRol) return { red: `${m} kişisinde <@&${korumaRol}> rolü var. Bu role sahip kişilere uyarı verilemez.` };
  const kurucuMu = i.user.id === i.guild.ownerId || (KURUCU_ID && i.user.id === KURUCU_ID);
  if (!kurucuMu && !superMi && i.member.roles.highest.position <= m.roles.highest.position) {
    return { red: 'Sadece kendinden alt rütbedeki kişilere uyarı verebilirsin.' };
  }
  if (!m.manageable) return { red: 'Bu kişinin rollerini yönetemem (rolü benden üstte ya da yetkim yok).' };
  return { m };
}

async function bilesenIslem(i) {
  // Yetkili uyarı: kişi seçildi -> sebep formu
  if (i.isUserSelectMenu() && i.customId === 'uyari_user') {
    const hedefId = i.values[0];
    const k = await uyariKontrol(i, hedefId);
    if (k.red) return await i.reply({ content: `❌ ${k.red}`, flags: MessageFlags.Ephemeral });
    const sayi = (data.uyarilar?.[hedefId]?.sayi || 0) + 1;
    const modal = new ModalBuilder().setCustomId(`uyari_modal_${hedefId}`).setTitle(`Uyarı Sebebi (${sayi}/${UYARI_MAX})`);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('sebep').setLabel('Sebep').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(300),
    ));
    return await i.showModal(modal);
  }

  // Yetkili uyarı: form gönderildi
  if (i.isModalSubmit() && i.customId.startsWith('uyari_modal_')) {
    const hedefId = i.customId.slice('uyari_modal_'.length);
    const sebep = i.fields.getTextInputValue('sebep');
    const k = await uyariKontrol(i, hedefId);
    if (k.red) return await i.reply({ content: `❌ ${k.red}`, flags: MessageFlags.Ephemeral });
    await i.deferReply({ flags: MessageFlags.Ephemeral });

    const m = k.m;
    const kayit = ((data.uyarilar ||= {})[hedefId] ||= { sayi: 0, kayit: [] });
    const yeniSayi = kayit.sayi + 1;
    let sonuc;

    if (yeniSayi >= UYARI_MAX) {
      panelBanlari.add(hedefId); setTimeout(() => panelBanlari.delete(hedefId), 30000);
      if (!m.bannable) return await i.editReply('❌ Bu kişiyi banlayamam (rolü benden üstte).');
      await i.guild.members.ban(hedefId, { reason: `${UYARI_MAX}x yetkili uyarısı — son uyarı: ${i.user.tag}: ${sebep}` });
      data.bans.push({ id: hedefId, tag: m.user.tag, yetkili: i.user.id, sebep: `${UYARI_MAX}x uyarı: ${sebep}`, t: Date.now() });
      sonuc = `🔨 <@${hedefId}> **${UYARI_MAX}. uyarısını** aldı ve sunucudan **banlandı**.`;
    } else {
      const roller = await uyariRolleri(i.guild);
      await m.roles.remove(roller.filter((r) => m.roles.cache.has(r.id)), 'Yetkili uyarı güncellendi').catch(() => {});
      await m.roles.add(roller[yeniSayi - 1], `${yeniSayi}x uyarı — ${i.user.tag}`);
      sonuc = `⚠️ <@${hedefId}> yetkilisine **${yeniSayi}x Uyarı** verildi. (${yeniSayi}/${UYARI_MAX})`;
    }

    kayit.sayi = yeniSayi;
    kayit.kayit.push({ t: Date.now(), yetkili: i.user.id, sebep });
    save();

    const embed = new EmbedBuilder().setColor(yeniSayi >= UYARI_MAX ? 0xe74c3c : 0xf39c12)
      .setTitle(yeniSayi >= UYARI_MAX ? '🔨 Yetkili 5. Uyarıda Banlandı' : `⚠️ Yetkili Uyarısı (${yeniSayi}/${UYARI_MAX})`)
      .setThumbnail(m.user.displayAvatarURL())
      .addFields(
        { name: 'Yetkili', value: `<@${hedefId}> (${hedefId})` },
        { name: 'Uyaran', value: `<@${i.user.id}>`, inline: true },
        { name: 'Uyarı Sayısı', value: `${yeniSayi}/${UYARI_MAX}`, inline: true },
        { name: 'Sebep', value: sebep },
      ).setTimestamp();
    const lg = await banLogGonder(embed, UYARI_LOG_KANAL_ID);
    if (yeniSayi >= UYARI_MAX) banLogGonder(EmbedBuilder.from(embed).addFields({ name: 'Kaynak', value: 'Yetkili Uyarı Sistemi', inline: true }));
    return await i.editReply(`${sonuc}${lg.ok ? '' : `\n⚠️ Log kanalına yazılamadı: ${lg.hata}`}`);
  }

  // DM duyuru formu
  if (i.isModalSubmit() && i.customId === 'dmduyuru_modal') return dmDuyuruGonder(i);

  // Ban: kişi seçildi -> sebep formu
  if (i.isUserSelectMenu() && i.customId === 'ban_user') {
    const hedefId = i.values[0];
    const red = await banKontrol(i, hedefId);
    if (red) return await i.reply({ content: `❌ ${red}`, flags: MessageFlags.Ephemeral });
    const modal = new ModalBuilder().setCustomId(`ban_modal_${hedefId}`).setTitle('Ban Sebebi');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('sebep').setLabel('Sebep').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(300),
    ));
    return await i.showModal(modal);
  }

  // Ban formu gönderildi
  if (i.isModalSubmit() && i.customId.startsWith('ban_modal_')) {
    const hedefId = i.customId.slice('ban_modal_'.length);
    const sebep = i.fields.getTextInputValue('sebep');
    const red = await banKontrol(i, hedefId);
    if (red) return await i.reply({ content: `❌ ${red}`, flags: MessageFlags.Ephemeral });
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const user = await client.users.fetch(hedefId).catch(() => null);
    panelBanlari.add(hedefId); setTimeout(() => panelBanlari.delete(hedefId), 30000);
    await i.guild.members.ban(hedefId, { reason: `${i.user.tag}: ${sebep}` });
    banHakKullan();
    data.bans.push({ id: hedefId, tag: user?.tag || hedefId, yetkili: i.user.id, sebep, t: Date.now() });
    save();
    const h = banHakki();
    if (i.message) i.message.edit(panelMesaji()).catch(() => {});
    const embed = new EmbedBuilder().setColor(0xe74c3c).setTitle('🔨 Kullanıcı Yasaklandı')
      .addFields(
        { name: 'Kullanıcı', value: `${user?.tag || 'Bilinmiyor'} (${hedefId})` },
        { name: 'Yetkili', value: `<@${i.user.id}>`, inline: true },
        { name: 'Kalan Hak', value: `${h.kalan}/${BAN_LIMIT}`, inline: true },
        { name: 'Sebep', value: sebep },
      ).setTimestamp();
    await i.channel.send({ embeds: [embed] }).catch(() => {});
    const lg = await banLogGonder(EmbedBuilder.from(embed).addFields({ name: 'Kaynak', value: 'Ban Paneli', inline: true }));
    return await i.editReply(`✅ <@${hedefId}> yasaklandı. Kalan ban hakkı: **${h.kalan}/${BAN_LIMIT}**${lg.ok ? '' : `\n⚠️ Log kanalına yazılamadı: ${lg.hata}`}`);
  }

  // Yasak kaldır: banlı listesi
  if (i.isButton() && i.customId === 'unban_liste') {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const bans = await i.guild.bans.fetch({ limit: 25 });
    if (!bans.size) return await i.editReply('ℹ️ Banlı kullanıcı yok.');
    const menu = new StringSelectMenuBuilder().setCustomId('unban_sec').setPlaceholder('Yasağı kaldırılacak kişiyi seç...')
      .addOptions([...bans.values()].slice(0, 25).map((b) => ({
        label: (b.user.username || b.user.id).slice(0, 100),
        value: b.user.id,
        description: (b.reason || 'Sebep yok').slice(0, 100),
      })));
    return await i.editReply({ content: 'Yasağını kaldırmak istediğin kişiyi seç (son 25 ban):', components: [new ActionRowBuilder().addComponents(menu)] });
  }

  if (i.isStringSelectMenu() && i.customId === 'unban_sec') {
    const id = i.values[0];
    await i.guild.bans.remove(id, `${i.user.tag} (panel)`).catch(() => { throw new Error('Bu kişi artık banlı değil.'); });
    i.channel.send({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle('✅ Yasak Kaldırıldı').setDescription(`\`${id}\` kullanıcısının yasağı <@${i.user.id}> tarafından kaldırıldı.`).setTimestamp()] }).catch(() => {});
    return await i.update({ content: `✅ \`${id}\` yasağı kaldırıldı.`, components: [] });
  }

  // Yasak kaldır: ID ile
  if (i.isButton() && i.customId === 'unban_id') {
    const modal = new ModalBuilder().setCustomId('unban_modal').setTitle('ID ile Yasak Kaldır');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('id').setLabel('Kullanıcı ID').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(25),
    ));
    return await i.showModal(modal);
  }

  if (i.isModalSubmit() && i.customId === 'unban_modal') {
    const id = i.fields.getTextInputValue('id').trim();
    if (!/^\d{17,20}$/.test(id)) return await i.reply({ content: '❌ Geçersiz ID.', flags: MessageFlags.Ephemeral });
    await i.guild.bans.remove(id, `${i.user.tag} (panel)`).catch(() => { throw new Error('Bu ID banlı değil.'); });
    i.channel.send({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle('✅ Yasak Kaldırıldı').setDescription(`\`${id}\` kullanıcısının yasağı <@${i.user.id}> tarafından kaldırıldı.`).setTimestamp()] }).catch(() => {});
    return await i.reply({ content: `✅ \`${id}\` yasağı kaldırıldı.`, flags: MessageFlags.Ephemeral });
  }
}

async function dmDuyuruGonder(i) {
  if (!i.memberPermissions.has(PermissionFlagsBits.Administrator)) return await hata(i, 'Yetkin yok.');
  const baslik = i.fields.getTextInputValue('baslik');
  const mesaj = i.fields.getTextInputValue('mesaj');
  await i.reply({ content: '📨 Duyuru gönderiliyor, lütfen bekle...', flags: MessageFlags.Ephemeral });

  const members = (await i.guild.members.fetch()).filter((m) => !m.user.bot);
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(baslik).setDescription(mesaj)
    .setFooter({ text: `${i.guild.name} • ${BOT_ADI}`, iconURL: i.guild.iconURL() || undefined }).setTimestamp();

  let ok = 0, fail = 0, n = 0;
  for (const m of members.values()) {
    try { await m.send({ embeds: [embed] }); ok++; } catch { fail++; }
    n++;
    if (n % 25 === 0) await i.editReply(`📨 Gönderiliyor... ${n}/${members.size}`).catch(() => {});
    await new Promise((r) => setTimeout(r, 1200)); // rate limit koruması
  }
  await i.editReply(`✅ Duyuru tamamlandı.\nBaşarılı: **${ok}** • DM kapalı/başarısız: **${fail}**`).catch(() => {});
}

process.on('unhandledRejection', (e) => console.error('Yakalanmamış hata:', e));
console.log('SÜRÜM: ban-panel-v10');
client.login(TOKEN);
