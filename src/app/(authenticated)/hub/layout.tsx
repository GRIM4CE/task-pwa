import HubTabs from "./_components/HubTabs";

export default function HubLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <HubTabs />
      {children}
    </div>
  );
}
