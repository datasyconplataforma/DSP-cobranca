import React, { useState, useEffect } from "react";
import { 
  GoogleAuthProvider, 
  signInWithPopup, 
  onAuthStateChanged, 
  User, 
  signOut 
} from "firebase/auth";
import { 
  collection, 
  query, 
  where, 
  onSnapshot, 
  addDoc, 
  serverTimestamp, 
  orderBy,
  doc,
  updateDoc
} from "firebase/firestore";
import { auth, db } from "./firebase";
import { 
  Plus, 
  LogOut, 
  MessageSquare, 
  User as UserIcon, 
  DollarSign, 
  Calendar,
  Send,
  ChevronRight,
  Loader2
} from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

// Tipos
interface Debt {
  id: string;
  debtorName: string;
  debtorPhone: string;
  amount: number;
  dueDate: string;
  status: "pending" | "negotiating" | "paid" | "overdue";
  uid: string;
  lastMessage?: string;
  lastMessageAt?: any;
}

interface Message {
  id: string;
  sender: "agent" | "debtor";
  content: string;
  timestamp: any;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [debts, setDebts] = useState<Debt[]>([]);
  const [selectedDebt, setSelectedDebt] = useState<Debt | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isStartingCollection, setIsStartingCollection] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Debts Listener
  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, "debts"), 
      where("uid", "==", user.uid),
      orderBy("createdAt", "desc")
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const debtList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Debt));
      setDebts(debtList);
    });
    return () => unsubscribe();
  }, [user]);

  // Messages Listener
  useEffect(() => {
    if (!selectedDebt) return;
    const q = query(
      collection(db, `debts/${selectedDebt.id}/messages`), 
      orderBy("timestamp", "asc")
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Message));
      setMessages(msgList);
    });
    return () => unsubscribe();
  }, [selectedDebt]);

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Erro no login:", error);
    }
  };

  const handleLogout = () => signOut(auth);

  const handleAddDebt = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    
    const formData = new FormData(e.currentTarget);
    const phone = (formData.get("phone") as string).replace(/\D/g, ""); // Remove non-digits
    
    if (phone.length < 10) {
      setError("Telefone inválido. Use o formato com DDD.");
      setIsSubmitting(false);
      return;
    }

    const newDebt = {
      debtorName: formData.get("name") as string,
      debtorPhone: `+${phone}`, // Ensure E.164
      amount: Number(formData.get("amount")),
      dueDate: formData.get("dueDate") as string,
      status: "pending",
      uid: user?.uid,
      createdAt: serverTimestamp()
    };

    try {
      await addDoc(collection(db, "debts"), newDebt);
      setShowAddModal(false);
    } catch (err: any) {
      console.error("Erro ao adicionar dívida:", err);
      setError("Erro ao salvar. Verifique sua conexão ou permissões.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Loader2 className="animate-spin text-blue-600" size={48} />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-white p-4">
        <div className="max-w-md w-full text-center space-y-8">
          <div className="bg-blue-600 w-20 h-20 rounded-3xl flex items-center justify-center mx-auto shadow-xl shadow-blue-200">
            <MessageSquare className="text-white" size={40} />
          </div>
          <div className="space-y-2">
            <h1 className="text-4xl font-bold tracking-tight">Cobrança Inteligente</h1>
            <p className="text-neutral-500">Recupere suas dívidas com a ajuda de inteligência artificial humanizada via WhatsApp.</p>
          </div>
          <button 
            onClick={handleLogin}
            className="w-full flex items-center justify-center gap-3 bg-white border border-neutral-200 px-6 py-4 rounded-2xl font-semibold hover:bg-neutral-50 transition-all shadow-sm"
          >
            <img src="https://www.google.com/favicon.ico" className="w-5 h-5" alt="Google" />
            Entrar com Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-neutral-50 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-80 bg-white border-r border-neutral-200 flex flex-col">
        <div className="p-6 border-bottom border-neutral-100 flex items-center justify-between">
          <h2 className="text-xl font-bold">Dívidas</h2>
          <button 
            onClick={() => setShowAddModal(true)}
            className="p-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors"
          >
            <Plus size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {debts.map((debt) => (
            <button
              key={debt.id}
              onClick={() => setSelectedDebt(debt)}
              className={`w-full text-left p-4 rounded-2xl transition-all border ${
                selectedDebt?.id === debt.id 
                  ? "bg-blue-50 border-blue-200 shadow-sm" 
                  : "bg-white border-transparent hover:bg-neutral-50"
              }`}
            >
              <div className="flex justify-between items-start mb-1">
                <span className="font-bold truncate text-neutral-900">{debt.debtorName}</span>
                <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded-full ${
                  debt.status === "paid" ? "bg-green-100 text-green-700" : 
                  debt.status === "negotiating" ? "bg-blue-100 text-blue-700" :
                  "bg-amber-100 text-amber-700"
                }`}>
                  {debt.status === "negotiating" ? "Em Negociação" : 
                   debt.status === "paid" ? "Pago" : 
                   debt.status === "pending" ? "Pendente" : "Atrasado"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs text-neutral-500">
                <div className="flex items-center gap-1">
                  <DollarSign size={12} />
                  <span>R$ {debt.amount.toLocaleString()}</span>
                </div>
                {debt.lastMessageAt?.toDate && (
                  <span>{format(debt.lastMessageAt.toDate(), "dd/MM")}</span>
                )}
              </div>
              {debt.lastMessage && (
                <p className="text-xs text-neutral-400 mt-2 truncate italic">
                  {debt.lastMessage}
                </p>
              )}
            </button>
          ))}
        </div>

        <div className="p-4 border-t border-neutral-100 bg-neutral-50/50">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
              <UserIcon size={20} className="text-blue-600" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold truncate">{user.displayName}</p>
              <p className="text-xs text-neutral-500 truncate">{user.email}</p>
            </div>
            <button onClick={handleLogout} className="p-2 text-neutral-400 hover:text-red-500 transition-colors">
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col bg-white">
        {selectedDebt ? (
          <>
            <header className="p-6 border-b border-neutral-100 flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-bold">{selectedDebt.debtorName}</h1>
                <p className="text-sm text-neutral-500">{selectedDebt.debtorPhone}</p>
              </div>
              <div className="flex gap-6 items-center">
                <div className="text-right">
                  <p className="text-xs text-neutral-400 uppercase font-bold">Vencimento</p>
                  <p className="font-medium">{format(new Date(selectedDebt.dueDate), "dd 'de' MMMM", { locale: ptBR })}</p>
                </div>
                <div className="text-right border-l border-neutral-100 pl-6">
                  <p className="text-xs text-neutral-400 uppercase font-bold">Valor Total</p>
                  <p className="text-xl font-bold text-blue-600">R$ {selectedDebt.amount.toLocaleString()}</p>
                </div>
                {selectedDebt.status === "pending" && (
                  <button 
                    disabled={isStartingCollection}
                    onClick={async () => {
                      setIsStartingCollection(true);
                      try {
                        const response = await fetch(`/api/debts/${selectedDebt.id}/start`, { method: "POST" });
                        const data = await response.json();
                        
                        if (!response.ok) {
                          throw new Error(data.error || "Falha ao iniciar cobrança");
                        }
                        
                        // Atualiza o estado local para feedback imediato
                        setSelectedDebt(prev => prev ? { ...prev, status: "negotiating" } : null);
                      } catch (error: any) {
                        console.error("Erro ao iniciar:", error);
                        alert(`Erro: ${error.message}`);
                      } finally {
                        setIsStartingCollection(false);
                      }
                    }}
                    className="ml-4 bg-green-600 text-white px-6 py-2.5 rounded-xl font-bold hover:bg-green-700 transition-all shadow-lg shadow-green-100 flex items-center gap-2 disabled:opacity-50"
                  >
                    {isStartingCollection ? (
                      <Loader2 className="animate-spin" size={18} />
                    ) : (
                      <Send size={18} />
                    )}
                    {isStartingCollection ? "Iniciando..." : "Iniciar Cobrança"}
                  </button>
                )}
              </div>
            </header>

            <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-neutral-50/30">
              {messages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center space-y-4 opacity-50">
                  <MessageSquare size={48} />
                  <p>Nenhuma mensagem trocada ainda.<br/>O agente iniciará a cobrança automaticamente.</p>
                </div>
              ) : (
                messages.map((msg) => (
                  <div key={msg.id} className={`flex ${msg.sender === "agent" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[70%] p-4 rounded-2xl shadow-sm ${
                      msg.sender === "agent" 
                        ? "bg-blue-600 text-white rounded-tr-none" 
                        : "bg-white border border-neutral-200 rounded-tl-none"
                    }`}>
                      <p className="text-sm leading-relaxed">{msg.content}</p>
                      <div className={`flex items-center gap-1 mt-2 opacity-70 ${msg.sender === "agent" ? "justify-end" : "justify-start"}`}>
                        <p className="text-[10px]">
                          {msg.timestamp?.toDate() ? format(msg.timestamp.toDate(), "HH:mm") : "Enviando..."}
                        </p>
                        {msg.sender === "agent" && <div className="w-3 h-3 bg-white/20 rounded-full flex items-center justify-center text-[8px]">✓</div>}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <footer className="p-6 border-t border-neutral-100">
              <div className="flex gap-4">
                <input 
                  type="text" 
                  placeholder="Simular resposta do devedor..." 
                  className="flex-1 px-4 py-3 rounded-xl border border-neutral-200 focus:ring-2 focus:ring-blue-500 outline-none"
                  onKeyDown={async (e) => {
                    if (e.key === "Enter") {
                      const content = e.currentTarget.value;
                      if (!content) return;
                      e.currentTarget.value = "";
                      
                      // Simula mensagem do devedor
                      await addDoc(collection(db, `debts/${selectedDebt.id}/messages`), {
                        sender: "debtor",
                        content,
                        timestamp: serverTimestamp()
                      });

                      // Chama o webhook para processar a resposta (em um app real, isso viria do WhatsApp)
                      fetch("/api/whatsapp/webhook", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ Body: content, From: selectedDebt.debtorPhone })
                      });
                    }
                  }}
                />
                <button className="p-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors">
                  <Send size={20} />
                </button>
              </div>
            </footer>
          </>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-center space-y-6 p-12">
            <div className="w-24 h-24 bg-neutral-100 rounded-full flex items-center justify-center">
              <MessageSquare size={40} className="text-neutral-300" />
            </div>
            <div className="space-y-2">
              <h2 className="text-2xl font-bold">Selecione uma cobrança</h2>
              <p className="text-neutral-500 max-w-xs mx-auto">Escolha um devedor na lista ao lado para ver o histórico de negociação e status da dívida.</p>
            </div>
          </div>
        )}
      </main>

      {/* Add Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl w-full max-w-md p-8 shadow-2xl">
            <h2 className="text-2xl font-bold mb-6">Nova Cobrança</h2>
            {error && (
              <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-xl text-sm font-medium">
                {error}
              </div>
            )}
            <form onSubmit={handleAddDebt} className="space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase text-neutral-400">Nome do Devedor</label>
                <input name="name" required className="input" placeholder="Ex: João Silva" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase text-neutral-400">WhatsApp</label>
                <input name="phone" required className="input" placeholder="Ex: +5511999999999" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-bold uppercase text-neutral-400">Valor (R$)</label>
                  <input name="amount" type="number" required className="input" placeholder="0.00" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-bold uppercase text-neutral-400">Vencimento</label>
                  <input name="dueDate" type="date" required className="input" />
                </div>
              </div>
              <div className="flex gap-3 pt-4">
                <button 
                  type="button" 
                  disabled={isSubmitting}
                  onClick={() => setShowAddModal(false)} 
                  className="flex-1 px-4 py-3 rounded-xl font-bold hover:bg-neutral-100 transition-colors disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button 
                  type="submit" 
                  disabled={isSubmitting}
                  className="flex-1 btn-primary py-3 rounded-xl font-bold flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isSubmitting ? <Loader2 className="animate-spin" size={20} /> : "Cadastrar"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
