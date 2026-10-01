import axios from "axios";
import { AttachmentBuilder, EmbedBuilder, WebhookClient } from "discord.js";
import FormData from "form-data";
import fs from "fs";
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const sendTelegramMessage = async (message) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    throw Error("Bot token or chat ID not defined.");
  }
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await axios.post(url, {
    chat_id: chatId,
    text: message,
    parse_mode: "html",
  });
};

export const sendTelegramMessageWithImage = async (message, imagePath) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    throw Error("Bot token or chat ID not defined.");
  }
  const url = `https://api.telegram.org/bot${botToken}/sendPhoto`;
  await axios.post(url, {
    chat_id: chatId,
    photo: imagePath,
    caption: message,
    parse_mode: "html",
  });
};
export const sendTelegramLocalImage = async (message, imagePath) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    throw new Error("Bot token o chat ID no definidos.");
  }
  const url = `https://api.telegram.org/bot${botToken}/sendPhoto`;
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("caption", message);
  formData.append("parse_mode", "html");
  formData.append("photo", fs.createReadStream(imagePath));
  try {
    await axios.post(url, formData);
  } catch (error) {
    console.error("Error sending image", error);
  }
};
const getDiscordWebhookUrl = () => {
  const url = process.env.DISCORD_WEBHOOK_URL?.trim();
  if (!url) return "";

  const isValidWebhook = /https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\//i.test(url);
  return isValidWebhook ? url : "";
};

const sendDiscordPayload = async (payload) => {
  const webhookUrl = getDiscordWebhookUrl();
  if (!webhookUrl) {
    console.warn("[!] Discord webhook URL is missing or invalid. Skipping Discord notification.");
    return false;
  }

  const webhookClient = new WebhookClient({ url: webhookUrl });
  await webhookClient.send(payload);
  return true;
};

export const sendDiscordMessage = async (title, message, color = 0x8a2be2) => {
  try {
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(color)
      .setDescription(message);

    await sendDiscordPayload({
      username: "OhMyBounty",
      avatarURL: "https://i.imgur.com/8uE8voU.jpeg",
      embeds: [embed],
    });
  } catch (e) {
    console.log(e);
  }
};

export const sendDiscordReport = async (engagement, report) => {
  try {
    const bugcrowdColors = [
      null,
      0xff0000,
      0xff8000,
      0xffff00,
      0x00ff00,
      0x0000ff,
    ];

    const embed = new EmbedBuilder()
      .setTitle(`🚨 New report in ${engagement.name} 🚨`)
      .setURL(`https://bugcrowd.com${report.engagement_path}`)
      .setColor(bugcrowdColors[report.priority])
      .setDescription(
        `**${report.title || "~~Redacted~~"}**\n\n` +
          `• **Priority:** ${report.priority}\n` +
          `• **Disclosed:** ${report.disclosed || report.accepted_at}\n` +
          `• **Bounty:** ${report.amount || 0} $\n` +
          `• **Points:** ${report.points || 0}\n` +
          `• **Status:** ${report.substate}\n` +
          `• **Researcher:** ${
            report.researcher_username
              ? `[${report.researcher_username}](https://bugcrowd.com${report.researcher_profile_path})`
              : "~~Private User~~"
          }\n` +
          `• **Target:** ${report.target}\n` +
          (report.disclosed
            ? `• **[Link](https://bugcrowd.com/${report.disclosure_report_url})**`
            : "")
      )
      .setThumbnail(report.logo_url || "https://i.imgur.com/AfFp7pu.png")
      .setTimestamp();

    await sendDiscordPayload({
      username: "OhMyBounty",
      avatarURL: "https://i.imgur.com/8uE8voU.jpeg",
      embeds: [embed],
    });
  } catch (e) {
    console.log(e);
  }
};

export const sendDiscordSubdomain = async (message, localImage) => {
  try {
    const attachment = new AttachmentBuilder(
      fs.readFileSync(localImage),
      { name: "live-target.png" }
    );

    await sendDiscordPayload({
      username: "OhMyBounty",
      avatarURL: "https://i.imgur.com/8uE8voU.jpeg",
      content: message,
      files: [attachment],
    });
  } catch (e) {
    console.log(e);
  }
};
