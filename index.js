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
  UserSelectMenuBuilder, StringSelectMenuBuilder,
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
const BAN_LIMIT = 5; // 1 saatte en fazla banlanacak kişi sayısı
const logoDosya = () => new AttachmentBuilder(path.join(__dirname, 'logo.png'), { name: 'logo.png' });
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

  new SlashCommandBuilder().setName('dmduyuru').setDescription('Sunucudaki herkese DM duyurusu gönder')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((c) => c.toJSON());

/* ------------------------- Hazır ------------------------- */
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
    if (!i.isChatInputCommand()) return await bilesenIslem(i);

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
        embed.setThumbnail('attachment://logo.png');
        return i.reply({ embeds: [embed], files: [logoDosya()] });
      }

      case 'ban': {
        const kurucu = i.user.id === i.guild.ownerId || (KURUCU_ID && i.user.id === KURUCU_ID);
        if (!kurucu) return hata(i, 'Bu paneli sadece sunucu kurucusu açabilir.');
        return i.reply({ ...panelMesaji(), files: [logoDosya()] });
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
/* ------------------------- Ban Paneli ------------------------- */
const SAAT = 3600e3;
function banHakki() {
  const now = Date.now();
  data.banLog = (data.banLog || []).filter((x) => now - x.t < SAAT);
  return {
    kullanilan: data.banLog.length,
    kalan: Math.max(0, BAN_LIMIT - data.banLog.length),
    acilis: data.banLog[0] ? data.banLog[0].t + SAAT : null,
  };
}

function panelMesaji() {
  const h = banHakki();
  const embed = new EmbedBuilder()
    .setColor(0x1e6fff)
    .setTitle('🔨 Fest Gun — Ban Paneli')
    .setDescription('Aşağıdaki menüden bir kişi seç, sebebini yaz ve yasakla.\nYasağı kaldırmak için **Yasak Kaldır** butonunu kullan.')
    .addFields(
      { name: '⏳ Saatlik Limit', value: `**${h.kalan}/${BAN_LIMIT}** ban hakkı kaldı`, inline: true },
      { name: '📜 Kural', value: `1 saatte en fazla **${BAN_LIMIT}** kişi banlanabilir.`, inline: true },
    )
    .setThumbnail('attachment://logo.png')
    .setFooter({ text: 'Fest Gun Moderation' })
    .setTimestamp();
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
  if (h.kalan <= 0) return `Saatlik ban limiti doldu (${BAN_LIMIT}/${BAN_LIMIT}). Yeni hak <t:${Math.floor(h.acilis / 1000)}:R> açılacak.`;
  if (hedefId === i.user.id) return 'Kendini banlayamazsın.';
  if (hedefId === client.user.id) return 'Beni banlayamazsın.';
  if (hedefId === i.guild.ownerId || (KURUCU_ID && hedefId === KURUCU_ID)) return 'Kurucu banlanamaz.';
  const m = await i.guild.members.fetch(hedefId).catch(() => null);
  if (m && !m.bannable) return 'Bu kişiyi banlayamam (rolü benden üstte ya da yetkim yok).';
  return null;
}

async function bilesenIslem(i) {
  // DM duyuru formu
  if (i.isModalSubmit() && i.customId === 'dmduyuru_modal') return dmDuyuruGonder(i);

  // Ban: kişi seçildi -> sebep formu
  if (i.isUserSelectMenu() && i.customId === 'ban_user') {
    const hedefId = i.values[0];
    const red = await banKontrol(i, hedefId);
    if (red) return i.reply({ content: `❌ ${red}`, flags: MessageFlags.Ephemeral });
    const modal = new ModalBuilder().setCustomId(`ban_modal_${hedefId}`).setTitle('Ban Sebebi');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('sebep').setLabel('Sebep').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(300),
    ));
    return i.showModal(modal);
  }

  // Ban formu gönderildi
  if (i.isModalSubmit() && i.customId.startsWith('ban_modal_')) {
    const hedefId = i.customId.slice('ban_modal_'.length);
    const sebep = i.fields.getTextInputValue('sebep');
    const red = await banKontrol(i, hedefId);
    if (red) return i.reply({ content: `❌ ${red}`, flags: MessageFlags.Ephemeral });
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const user = await client.users.fetch(hedefId).catch(() => null);
    await i.guild.members.ban(hedefId, { reason: `${i.user.tag}: ${sebep}` });
    (data.banLog ||= []).push({ t: Date.now(), id: hedefId, yetkili: i.user.id });
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
    return i.editReply(`✅ <@${hedefId}> yasaklandı. Kalan ban hakkı: **${h.kalan}/${BAN_LIMIT}**`);
  }

  // Yasak kaldır: banlı listesi
  if (i.isButton() && i.customId === 'unban_liste') {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const bans = await i.guild.bans.fetch({ limit: 25 });
    if (!bans.size) return i.editReply('ℹ️ Banlı kullanıcı yok.');
    const menu = new StringSelectMenuBuilder().setCustomId('unban_sec').setPlaceholder('Yasağı kaldırılacak kişiyi seç...')
      .addOptions([...bans.values()].slice(0, 25).map((b) => ({
        label: (b.user.username || b.user.id).slice(0, 100),
        value: b.user.id,
        description: (b.reason || 'Sebep yok').slice(0, 100),
      })));
    return i.editReply({ content: 'Yasağını kaldırmak istediğin kişiyi seç (son 25 ban):', components: [new ActionRowBuilder().addComponents(menu)] });
  }

  if (i.isStringSelectMenu() && i.customId === 'unban_sec') {
    const id = i.values[0];
    await i.guild.bans.remove(id, `${i.user.tag} (panel)`).catch(() => { throw new Error('Bu kişi artık banlı değil.'); });
    i.channel.send({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle('✅ Yasak Kaldırıldı').setDescription(`\`${id}\` kullanıcısının yasağı <@${i.user.id}> tarafından kaldırıldı.`).setTimestamp()] }).catch(() => {});
    return i.update({ content: `✅ \`${id}\` yasağı kaldırıldı.`, components: [] });
  }

  // Yasak kaldır: ID ile
  if (i.isButton() && i.customId === 'unban_id') {
    const modal = new ModalBuilder().setCustomId('unban_modal').setTitle('ID ile Yasak Kaldır');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('id').setLabel('Kullanıcı ID').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(25),
    ));
    return i.showModal(modal);
  }

  if (i.isModalSubmit() && i.customId === 'unban_modal') {
    const id = i.fields.getTextInputValue('id').trim();
    if (!/^\d{17,20}$/.test(id)) return i.reply({ content: '❌ Geçersiz ID.', flags: MessageFlags.Ephemeral });
    await i.guild.bans.remove(id, `${i.user.tag} (panel)`).catch(() => { throw new Error('Bu ID banlı değil.'); });
    i.channel.send({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle('✅ Yasak Kaldırıldı').setDescription(`\`${id}\` kullanıcısının yasağı <@${i.user.id}> tarafından kaldırıldı.`).setTimestamp()] }).catch(() => {});
    return i.reply({ content: `✅ \`${id}\` yasağı kaldırıldı.`, flags: MessageFlags.Ephemeral });
  }
}

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
