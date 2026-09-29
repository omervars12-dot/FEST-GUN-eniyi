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
  ChannelType, ActivityType,
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
const LOGO_URL = process.env.LOGO_URL || null;
const SES_KANAL_ID = process.env.SES_KANAL_ID || '1542872463870922814';

if (!TOKEN) {
  console.error('DISCORD_TOKEN ortam değişkeni tanımlı değil!');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates],
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

  new SlashCommandBuilder().setName('ban').setDescription('Kullanıcıyı yasakla')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((o) => o.setName('kullanıcı').setDescription('Yasaklanacak kişi').setRequired(true))
    .addStringOption((o) => o.setName('sebep').setDescription('Sebep')),

  new SlashCommandBuilder().setName('unban').setDescription('Yasağı kaldır')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption((o) => o.setName('id').setDescription('Kullanıcı ID').setRequired(true)),

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

  new SlashCommandBuilder().setName('oluşum-ekle').setDescription('Yeni oluşum (rol + kategori + kanallar) oluştur')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((o) => o.setName('isim').setDescription('Oluşum adı').setRequired(true))
    .addStringOption((o) => o.setName('renk').setDescription('Hex renk, örn: #ff0000'))
    .addUserOption((o) => o.setName('lider').setDescription('Oluşum lideri')),

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

  new SlashCommandBuilder().setName('dmduyuru').setDescription('Sunucudaki herkese DM duyurusu gönder')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((c) => c.toJSON());

/* ------------------------- Hazır ------------------------- */
client.once('ready', async () => {
  console.log(`${BOT_ADI} giriş yaptı: ${client.user.tag}`);
  client.user.setPresence({ activities: [{ name: '/sunucu • /mesai', type: ActivityType.Watching }] });
  try {
    if (GUILD_ID) {
      await client.application.commands.set([], undefined); // global temizle (çift görünmesin)
      await client.application.commands.set(commands, GUILD_ID);
      console.log('Komutlar sunucuya kaydedildi (anında aktif).');
    } else {
      await client.application.commands.set(commands);
      console.log('Komutlar global kaydedildi (görünmesi biraz sürebilir).');
    }
  } catch (e) { console.error('Komut kayıt hatası:', e); }

  sesKanalinaGir();
  haftalikKontrol();
  setInterval(haftalikKontrol, 60 * 1000);
});

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
    if (i.isModalSubmit() && i.customId === 'dmduyuru_modal') return dmDuyuruGonder(i);
    if (!i.isChatInputCommand()) return;

    const sub = i.options.getSubcommand(false);

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
        if (LOGO_URL) embed.setThumbnail(LOGO_URL).setImage(LOGO_URL);
        return i.reply({ embeds: [embed] });
      }

      case 'ban': {
        const user = i.options.getUser('kullanıcı');
        const sebep = i.options.getString('sebep') || 'Sebep belirtilmedi';
        const m = await i.guild.members.fetch(user.id).catch(() => null);
        if (m && !m.bannable) return hata(i, 'Bu kullanıcıyı banlayamam (yetkim/rol sıram yetersiz).');
        if (user.id === i.user.id) return hata(i, 'Kendini banlayamazsın.');
        await i.guild.members.ban(user.id, { reason: `${i.user.tag}: ${sebep}` });
        data.bans.push({ id: user.id, tag: user.tag, yetkili: i.user.id, sebep, t: Date.now() });
        save();
        return i.reply({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('🔨 Kullanıcı Yasaklandı')
          .addFields({ name: 'Kullanıcı', value: `${user.tag} (${user.id})` }, { name: 'Yetkili', value: `<@${i.user.id}>` }, { name: 'Sebep', value: sebep }).setTimestamp()] });
      }

      case 'unban': {
        const id = i.options.getString('id').trim();
        await i.guild.bans.remove(id, `${i.user.tag} tarafından kaldırıldı`).catch(() => { throw new Error('Bu ID banlı değil ya da geçersiz.'); });
        return i.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle('✅ Yasak Kaldırıldı').setDescription(`\`${id}\` kullanıcısının yasağı <@${i.user.id}> tarafından kaldırıldı.`).setTimestamp()] });
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
        return i.reply({ embeds: [embed] });
      }

      case 'kick': {
        const user = i.options.getUser('kullanıcı');
        const sebep = i.options.getString('sebep') || 'Sebep belirtilmedi';
        const m = await i.guild.members.fetch(user.id).catch(() => null);
        if (!m) return hata(i, 'Kullanıcı sunucuda değil.');
        if (!m.kickable) return hata(i, 'Bu kullanıcıyı atamam (yetkim/rol sıram yetersiz).');
        await m.kick(`${i.user.tag}: ${sebep}`);
        return i.reply({ embeds: [new EmbedBuilder().setColor(0xe67e22).setTitle('👢 Kullanıcı Atıldı')
          .addFields({ name: 'Kullanıcı', value: `${user.tag} (${user.id})` }, { name: 'Yetkili', value: `<@${i.user.id}>` }, { name: 'Sebep', value: sebep }).setTimestamp()] });
      }

      case 'rolver':
      case 'rolal': {
        const user = i.options.getUser('kullanıcı');
        const rol = i.options.getRole('rol');
        const m = await i.guild.members.fetch(user.id).catch(() => null);
        if (!m) return hata(i, 'Kullanıcı sunucuda değil.');
        const me = i.guild.members.me;
        if (rol.position >= me.roles.highest.position || rol.managed) return hata(i, 'Bu rolü yönetemem (rolüm bu rolden düşük ya da rol bot rolü).');
        if (i.member.id !== i.guild.ownerId && rol.position >= i.member.roles.highest.position) return hata(i, 'Kendi rolünden yüksek/eşit rolü yönetemezsin.');
        if (i.commandName === 'rolver') await m.roles.add(rol); else await m.roles.remove(rol);
        return i.reply({ embeds: [new EmbedBuilder().setColor(rol.color || 0x5865f2)
          .setDescription(`${i.commandName === 'rolver' ? '✅' : '➖'} <@${user.id}> kullanıcısına ${rol} rolü ${i.commandName === 'rolver' ? 'verildi' : 'alındı'}.`)] });
      }

      case 'oluşum-ekle': {
        await i.deferReply();
        const isim = i.options.getString('isim');
        const renkStr = i.options.getString('renk');
        const lider = i.options.getUser('lider');
        const renk = renkStr && /^#?[0-9a-f]{6}$/i.test(renkStr) ? parseInt(renkStr.replace('#', ''), 16) : 0x5865f2;
        const rol = await i.guild.roles.create({ name: isim, color: renk, mentionable: true, reason: `Oluşum: ${i.user.tag}` });
        const kategori = await i.guild.channels.create({
          name: `📁 ${isim}`, type: ChannelType.GuildCategory,
          permissionOverwrites: [
            { id: i.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: rol.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
          ],
        });
        await i.guild.channels.create({ name: `${isim}-sohbet`, type: ChannelType.GuildText, parent: kategori.id });
        await i.guild.channels.create({ name: `${isim} Ses`, type: ChannelType.GuildVoice, parent: kategori.id });
        if (lider) { const lm = await i.guild.members.fetch(lider.id).catch(() => null); if (lm) await lm.roles.add(rol).catch(() => {}); }
        data.olusumlar.push({ isim, rol: rol.id, kategori: kategori.id, lider: lider?.id || null, t: Date.now() });
        save();
        return i.editReply({ embeds: [new EmbedBuilder().setColor(renk).setTitle('🏴 Oluşum Oluşturuldu')
          .addFields({ name: 'Oluşum', value: `${rol}`, inline: true }, { name: 'Lider', value: lider ? `<@${lider.id}>` : 'Yok', inline: true }, { name: 'Kanallar', value: 'Özel kategori, yazı ve ses kanalı açıldı.' }).setTimestamp()] });
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
        return i.editReply({ embeds: [embed] });
      }

      case 'destek-islem': {
        if (sub === 'ekle') {
          if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) return hata(i, 'Bu komutu kullanmak için "Sunucuyu Yönet" yetkisi gerekir.');
          const y = i.options.getUser('yetkili');
          const adet = i.options.getInteger('adet') || 1;
          const not = i.options.getString('not');
          const k = (data.destek[y.id] ||= { toplam: 0, kayit: [] });
          k.toplam += adet;
          k.kayit.push({ t: Date.now(), adet, not, ekleyen: i.user.id });
          k.kayit = k.kayit.slice(-200);
          save();
          return i.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle('🎫 Destek İşlemi Eklendi')
            .setDescription(`<@${y.id}> yetkilisine **${adet}** destek işlemi eklendi.\nToplam: **${k.toplam}**${not ? `\nNot: ${not}` : ''}`).setTimestamp()] });
        }
        if (sub === 'top') {
          const list = Object.entries(data.destek).sort((a, b) => b[1].toplam - a[1].toplam).slice(0, 15);
          const medals = ['🥇', '🥈', '🥉'];
          return i.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🏆 Destek İşlem Sıralaması')
            .setDescription(list.map(([u, v], n) => `${medals[n] || `**${n + 1}.**`} <@${u}> — **${v.toplam}** işlem`).join('\n') || '*Kayıt yok.*').setTimestamp()] });
        }
        if (sub === 'istatistik') {
          const y = i.options.getUser('yetkili') || i.user;
          const k = data.destek[y.id];
          if (!k) return i.reply({ content: `ℹ️ <@${y.id}> için destek işlem kaydı yok.`, flags: MessageFlags.Ephemeral });
          const haftaBasi = weekStart(Date.now());
          const hafta = k.kayit.filter((x) => x.t >= haftaBasi).reduce((a, b) => a + b.adet, 0);
          const son = k.kayit.slice(-5).reverse().map((x) => `• ${fmtDate(x.t)} — +${x.adet}${x.not ? ` (${x.not})` : ''}`).join('\n');
          return i.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`🎫 ${y.username} — Destek İstatistiği`)
            .addFields({ name: 'Toplam', value: `**${k.toplam}**`, inline: true }, { name: 'Bu Hafta', value: `**${hafta}**`, inline: true }, { name: 'Son Kayıtlar', value: son || '-' }).setTimestamp()] });
        }
        break;
      }

      case 'mesai': {
        const uid = i.user.id;
        if (sub === 'gir') {
          if (data.aktif[uid]) return hata(i, `Zaten mesaidesin (başlangıç: ${fmtDate(data.aktif[uid])}).`);
          data.aktif[uid] = Date.now(); save();
          return i.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle('🟢 Mesaiye Girildi').setDescription(`<@${uid}> mesaiye girdi.\n🕒 ${fmtDate(data.aktif[uid])}`)] });
        }
        if (sub === 'çık') {
          const s = data.aktif[uid];
          if (!s) return hata(i, 'Şu an mesaide değilsin.');
          const e = Date.now();
          data.mesai.push({ u: uid, s, e }); delete data.aktif[uid]; save();
          return i.reply({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('🔴 Mesaiden Çıkıldı').setDescription(`<@${uid}> mesaiden çıktı.\n⏱️ Süre: **${fmtDur(e - s)}**`)] });
        }
        if (sub === 'tablo') {
          const ws = weekStart(Date.now());
          return i.reply({ embeds: [tabloEmbed('📊 Haftalık Mesai Tablosu', totals(ws, Date.now() + 1), `Hafta başlangıcı: ${fmtDate(ws)}`)] });
        }
        if (sub === 'sıralama') {
          const ds = dayStart(Date.now());
          return i.reply({ embeds: [tabloEmbed('🏅 Bugünün En Aktif Kişileri', totals(ds, Date.now() + 1), `Tarih: ${new Date().toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' })}`)] });
        }
        break;
      }

      case 'dmduyuru': {
        const modal = new ModalBuilder().setCustomId('dmduyuru_modal').setTitle('DM Duyurusu');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('baslik').setLabel('Başlık').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('mesaj').setLabel('Mesaj').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000)),
        );
        return i.showModal(modal);
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
async function dmDuyuruGonder(i) {
  if (!i.memberPermissions.has(PermissionFlagsBits.Administrator)) return hata(i, 'Yetkin yok.');
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
client.login(TOKEN);
