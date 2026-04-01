import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import cors from "cors";
import bodyParser from "body-parser";
import twilio from "twilio";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import admin from "firebase-admin";
import fs from "fs";
import axios from "axios";

dotenv.config();

console.log("Starting server initialization...");

// Initialize Firebase Admin
const firebaseConfig = JSON.parse(fs.readFileSync("./firebase-applet-config.json", "utf-8"));

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: firebaseConfig.projectId,
  });
}

// Use the named database if provided
const db = admin.firestore(firebaseConfig.firestoreDatabaseId);
const FieldValue = admin.firestore.FieldValue;

console.log("Firebase Admin initialized for database:", firebaseConfig.firestoreDatabaseId);

// Test Firestore Connection
async function testFirestore() {
  try {
    console.log("Testing Firestore connection...");
    const testSnap = await db.collection("debts").limit(1).get();
    console.log("Firestore connection successful, found", testSnap.size, "debts");
  } catch (err) {
    console.error("Firestore connection test failed:", err);
  }
}
testFirestore();

// Initialize Twilio Client
let twilioClient: any = null;

async function startServer() {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    console.log("Twilio client initialized");
  }
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(bodyParser.json());

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Start Collection Endpoint
  app.post("/api/debts/:id/start", async (req, res) => {
    const { id } = req.params;
    
    try {
      // 1. Get Debt Info
      const debtRef = db.collection("debts").doc(id);
      const debtSnap = await debtRef.get();
      
      if (!debtSnap.exists) return res.status(404).json({ error: "Dívida não encontrada" });
      const debt = debtSnap.data()!;

      // 2. Generate Initial Message with Gemini
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY não configurada nas Secrets" });
      
      const ai = new GoogleGenAI({ apiKey });
      
      const prompt = `Você é um assistente de cobrança humanizado chamado "Agente IA". 
      Sua tarefa é iniciar uma conversa de cobrança com ${debt.debtorName}.
      Valor da dívida: R$ ${debt.amount}. Vencimento: ${debt.dueDate}.
      Escreva uma mensagem inicial amigável, mas profissional, lembrando do débito e perguntando se há algum problema com o pagamento.
      Mantenha a mensagem curta para WhatsApp. Não use tons agressivos.`;

      const result = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ parts: [{ text: prompt }] }]
      });
      const initialMessage = result.text || "Olá! Gostaria de conversar sobre sua pendência.";

      // 3. Send via Z-API or Twilio
      let sent = false;
      
      // Try Z-API first
      if (process.env.ZAPI_INSTANCE_ID && process.env.ZAPI_TOKEN) {
        try {
          const zapiUrl = `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}/send-text`;
          await axios.post(zapiUrl, {
            phone: debt.debtorPhone.replace("+", ""),
            message: initialMessage
          }, {
            headers: { "Client-Token": process.env.ZAPI_CLIENT_TOKEN || "" }
          });
          console.log(`Mensagem enviada via Z-API para ${debt.debtorPhone}`);
          sent = true;
        } catch (err: any) {
          console.error("Erro ao enviar via Z-API:", err.response?.data || err.message);
        }
      }

      // Fallback to Twilio
      if (!sent && twilioClient && process.env.TWILIO_WHATSAPP_NUMBER) {
        try {
          await twilioClient.messages.create({
            body: initialMessage,
            from: process.env.TWILIO_WHATSAPP_NUMBER,
            to: `whatsapp:${debt.debtorPhone}`
          });
          console.log(`Mensagem enviada via Twilio para ${debt.debtorPhone}`);
          sent = true;
        } catch (err: any) {
          console.error("Erro ao enviar via Twilio:", err);
        }
      }

      // 4. Save to Firestore
      await debtRef.collection("messages").add({
        sender: "agent",
        content: initialMessage,
        timestamp: FieldValue.serverTimestamp()
      });

      await debtRef.update({ 
        status: "negotiating",
        lastMessage: initialMessage,
        lastMessageAt: FieldValue.serverTimestamp()
      });

      res.json({ success: true, message: initialMessage });
    } catch (error: any) {
      console.error("Erro ao iniciar cobrança:", error);
      res.status(500).json({ error: error.message || "Erro interno" });
    }
  });

  // WhatsApp Webhook (Z-API or Twilio)
  app.post("/api/whatsapp/webhook", async (req, res) => {
    // Handle Z-API or Twilio formats
    const isZApi = !!req.body.instanceId;
    
    // For Z-API, only process ReceivedMessage
    if (isZApi && req.body.type !== "ReceivedMessage") {
      return res.status(200).send();
    }

    const Body = req.body.Body || req.body.text?.message || req.body.image?.caption || req.body.video?.caption;
    const From = req.body.From || (req.body.phone ? `whatsapp:+${req.body.phone}` : "");
    
    // Clean phone number (remove whatsapp: prefix, +, and any non-digits)
    const phone = From ? From.replace("whatsapp:", "").replace(/\D/g, "") : "";

    if (!phone || !Body) return res.status(200).send();

    try {
      // 1. Find Debt by Phone (try with and without +)
      let snapshot = await db.collection("debts")
        .where("debtorPhone", "==", `+${phone}`)
        .limit(1)
        .get();
      
      if (snapshot.empty) {
        snapshot = await db.collection("debts")
          .where("debtorPhone", "==", phone)
          .limit(1)
          .get();
      }
      
      if (snapshot.empty) {
        console.log(`Dívida não encontrada para o telefone ${phone}`);
        return res.status(200).send();
      }

      const debtDoc = snapshot.docs[0];
      const debt = debtDoc.data();
      const debtId = debtDoc.id;
      const debtRef = db.collection("debts").doc(debtId);

      // 2. Save Debtor Message
      await debtRef.collection("messages").add({
        sender: "debtor",
        content: Body,
        timestamp: FieldValue.serverTimestamp()
      });
      await debtRef.update({
        lastMessage: Body,
        lastMessageAt: FieldValue.serverTimestamp()
      });

      // 3. Get Context (Last 6 messages)
      const msgSnap = await debtRef.collection("messages")
        .orderBy("timestamp", "desc")
        .limit(6)
        .get();
      
      const history = msgSnap.docs.reverse().map(d => `${d.data().sender === "agent" ? "Agente" : "Devedor"}: ${d.data().content}`).join("\n");

      // 4. Generate AI Response
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return res.status(500).send();
      
      const ai = new GoogleGenAI({ apiKey });
      
      const prompt = `Você é um assistente de cobrança humanizado. 
      Contexto da Dívida: Devedor ${debt.debtorName}, Valor R$ ${debt.amount}, Vencimento ${debt.dueDate}.
      Histórico recente:
      ${history}
      
      O devedor acabou de dizer: "${Body}".
      Responda de forma empática, buscando um acordo. Se ele propuser um parcelamento, seja flexível mas peça uma data.
      Se ele disser que já pagou, peça o comprovante.
      Mantenha a resposta curta para WhatsApp.`;

      const result = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ parts: [{ text: prompt }] }]
      });
      const responseText = result.text || "Entendi. Como podemos resolver isso?";

      // 5. Save Agent Message
      await debtRef.collection("messages").add({
        sender: "agent",
        content: responseText,
        timestamp: FieldValue.serverTimestamp()
      });
      await debtRef.update({
        lastMessage: responseText,
        lastMessageAt: FieldValue.serverTimestamp()
      });

      // 6. Respond to Client (Z-API or Twilio)
      if (req.body.instanceId) {
        // Z-API Webhook - Send response via API
        try {
          const zapiUrl = `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}/send-text`;
          await axios.post(zapiUrl, {
            phone: phone,
            message: responseText
          }, {
            headers: { "Client-Token": process.env.ZAPI_CLIENT_TOKEN || "" }
          });
        } catch (err: any) {
          console.error("Erro ao responder via Z-API:", err.response?.data || err.message);
        }
        res.status(200).send();
      } else {
        // Twilio Webhook
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message(responseText);
        res.type("text/xml").send(twiml.toString());
      }

    } catch (error) {
      console.error("Erro no Webhook:", error);
      res.status(500).send();
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is listening on http://0.0.0.0:${PORT}`);
    console.log("Environment:", process.env.NODE_ENV || "development");
  });
}

console.log("Calling startServer()...");
startServer().catch(err => {
  console.error("Fatal error in startServer:", err);
});
