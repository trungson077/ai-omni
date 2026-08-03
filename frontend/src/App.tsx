import ChatPanel from "./components/ChatPanel";

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 800,
    margin: "0 auto",
    padding: 24,
    fontFamily: "'Segoe UI', system-ui, sans-serif",
    color: "#e0e0e0",
    minHeight: "100vh",
  },
  title: {
    textAlign: "center",
    marginBottom: 24,
    fontSize: 24,
    fontWeight: 700,
    color: "#fff",
  },
};

export default function App() {
  return (
    <div style={styles.container}>
      <h1 style={styles.title}>AIOmni</h1>
      <ChatPanel />
    </div>
  );
}
