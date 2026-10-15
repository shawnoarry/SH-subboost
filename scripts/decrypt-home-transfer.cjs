const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function decryptTransfer(text, password) {
  if (Buffer.byteLength(text) > 24 * 1024 * 1024) throw new Error("迁移文件过大。");
  const envelope = JSON.parse(text);
  if (envelope.format !== "subboost-home-private-encrypted/v1" || envelope.kdf !== "PBKDF2-SHA256" || envelope.iterations !== 600000 || envelope.cipher !== "AES-256-GCM") throw new Error("迁移文件格式无效。");
  const salt = Buffer.from(envelope.salt, "base64"), iv = Buffer.from(envelope.iv, "base64"), data = Buffer.from(envelope.data, "base64");
  if (salt.length !== 16 || iv.length !== 12 || data.length < 16) throw new Error("迁移文件参数无效。");
  const key = crypto.pbkdf2Sync(password, salt, 600000, 32, "sha256");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(envelope.format));
  decipher.setAuthTag(data.subarray(-16));
  let cleartext;
  try {
    cleartext = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
    const result = JSON.parse(cleartext.toString("utf8"));
    if (result.format !== "subboost-home-private/v1" || typeof result.yaml !== "string" || !result.selections || typeof result.selections !== "object") throw new Error("迁移数据无效。");
    return result;
  } catch { throw new Error("解锁密码不正确，或迁移文件已损坏。"); }
  finally { key.fill(0); cleartext?.fill(0); }
}

function main(args = process.argv.slice(2)) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (!["--input", "--password-file", "--output"].includes(args[index]) || !args[index + 1]) throw new Error("用法：--input 加密文件 --password-file 本机密码文件 --output 私密输出目录");
    values.set(args[index], args[index + 1]);
  }
  if (values.size !== 3) throw new Error("必须提供加密文件、单独的本机密码文件和私密输出目录；不要把密码放进命令行。");
  const directory = path.resolve(values.get("--output"));
  const configFile = path.join(directory, "clash-home.yaml"), choicesFile = path.join(directory, "clash-group-selections.json");
  if (fs.existsSync(configFile) || fs.existsSync(choicesFile)) throw new Error("输出文件已经存在，为保护配置不会覆盖。");
  const password = fs.readFileSync(values.get("--password-file"), "utf8").trim();
  const payload = decryptTransfer(fs.readFileSync(values.get("--input"), "utf8"), password);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(configFile, payload.yaml, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(choicesFile, JSON.stringify(payload.selections, null, 2), { flag: "wx", mode: 0o600 });
  console.log("已在指定本机目录生成 Clash YAML 和分组选择记录。含节点凭据，请勿入 Git 或上传。尚未导入或切换 Clash 配置。");
}

if (require.main === module) { try { main(); } catch (error) { console.error(`[SubBoost] ${error.message}`); process.exitCode = 1; } }
module.exports = { decryptTransfer, main };
