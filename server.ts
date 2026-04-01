import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import cors from "cors";
import bodyParser from "body-parser";
import twilio from "twilio";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import * as admin from "firebase-admin";
import fs from "fs";

dotenv.config();

// Initialize Firebase Admin
const firebaseConfig = JSON.parse(fs.readFileSync("./firebase-applet-config.json", "utf-8"));
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: firebaseConfig.projectId,
  });
}
const db = admin.firestore(admin.app());
// Handle named database if present
if (firebaseConfig.firestoreDatabaseId && firebaseConfig.firestoreDatabaseId !== "(default)") {
  // Note: In some versions of firebase-admin, you set the databaseId differently.
  // For standard usage, we'll assume the default or handle it if the SDK supports it.
  // Actually, admin.firestore() uses the default database. 
  // If a specific databaseId is needed, we might need a different approach, 
  // but usually in AI Studio the default is used or the projectId is enough.
}

// Initialize Twilio Client
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN 
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

async function startServer() {
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

      // 3. Send via Twilio if configured
      if (twilioClient && process.env.TWILIO_WHATSAPP_NUMBER) {
        try {
          await twilioClient.messages.create({
            body: initialMessage,
            from: process.env.TWILIO_WHATSAPP_NUMBER,
            to: `whatsapp:${debt.debtorPhone}`
          });
          console.log(`Mensagem enviada para ${debt.debtorPhone}`);
        } catch (err: any) {
          console.error("Erro ao enviar via Twilio:", err);
        }
      }

      // 4. Save to Firestore
      await debtRef.collection("messages").add({
        sender: "agent",
        content: initialMessage,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      await debtRef.update({ 
        status: "negotiating",
        lastMessage: initialMessage,
        lastMessageAt: admin.firestore.FieldValue.serverTimestamp()
      });

      res.json({ success: true, message: initialMessage });
    } catch (error: any) {
      console.error("Erro ao iniciar cobrança:", error);
      res.status(500).json({ error: error.message || "Erro interno" });
    }
  });

  // WhatsApp Webhook (Twilio)
  app.post("/api/whatsapp/webhook", async (req, res) => {
    const { Body, From } = req.body; 
    const phone = From ? From.replace("whatsapp:", "") : "";

    if (!phone || !Body) return res.status(200).send();

    try {
      // 1. Find Debt by Phone
      const snapshot = await db.collection("debts")
        .where("debtorPhone", "==", phone)
        .limit(1)
        .get();
      
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
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
      await debtRef.update({
        lastMessage: Body,
        lastMessageAt: admin.firestore.FieldValue.serverTimestamp()
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
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
      await debtRef.update({
        lastMessage: responseText,
        lastMessageAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // 6. Respond to Twilio
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(responseText);
      res.type("text/xml").send(twiml.toString());

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
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
