export const demoWindow = { from: "2026-10-24", through: "2026-11-22" };
export const demoRetrievedAt = "2026-11-22T06:00:00.000Z";

export const demoCompanies = [
  {
    name: "Nova Labs",
    domain: "nova-labs.example",
    recruiter: { subject: "domino-nova-recruiter", name: "Anika", title: "Technical Recruiter" },
    roles: [
      { title: "Inference Platform Engineer", date: "2026-11-17", excerpt: "Operate vLLM model serving on Kubernetes and improve serving latency." },
      { title: "GPU Kernel Engineer", date: "2026-11-19", excerpt: "Write CUDA and Triton kernels for GPU inference." },
    ],
    headcount: [100, 112],
    funding: { date: "2026-11-05", round: "Series A", amountUsd: 12_000_000 },
    transitions: [{ kind: "hire", date: "2026-11-14", count: 2, label: "Two observed inference hires from Atlas AI" }],
  },
  {
    name: "Atlas AI",
    domain: "atlas-ai.example",
    recruiter: { subject: "domino-atlas-recruiter", name: "Ishaan", title: "Talent Lead" },
    roles: [{ title: "Model Serving Engineer", date: "2026-11-12", excerpt: "Deploy model serving services and Python APIs for production workloads." }],
    headcount: [100, 104],
    funding: { date: "2026-10-27", round: "Seed", amountUsd: 4_000_000 },
    transitions: [{ kind: "departure", date: "2026-11-14", count: 2, label: "Two observed inference moves to Nova Labs" }],
  },
  {
    name: "Meridian Compute",
    domain: "meridian-compute.example",
    recruiter: { subject: "domino-meridian-recruiter", name: "Samira", title: "Talent Partner" },
    roles: [{ title: "ML Infrastructure Engineer", date: "2026-11-10", excerpt: "Maintain Kubernetes clusters and Python tooling for model evaluation." }],
    headcount: [80, 83],
    funding: { date: "2026-09-20", round: "Seed", amountUsd: 6_000_000 },
    transitions: [],
  },
] as const;

export const demoCandidates = [
  { name: "Mira", subject: "domino-mira", excerpt: "Ran SGLang model serving on Kubernetes and tuned latency under production load." },
  { name: "Dev", subject: "domino-dev", excerpt: "Wrote CUDA and Triton GPU kernels for inference workloads." },
  { name: "Leena", subject: "domino-leena", excerpt: "Maintained Kubernetes for model serving and measured throughput." },
] as const;

export const rahulWork = "Deployed vLLM on Kubernetes for model serving, profiled serving latency, and built Python tooling.";
