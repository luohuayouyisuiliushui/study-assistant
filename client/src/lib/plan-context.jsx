import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import api from '../api';

const PlanContext = createContext(null);

export function PlanProvider({ children }) {
  const [plans, setPlans] = useState([]);
  const [currentPlan, setCurrentPlan] = useState(null);

  const refreshPlans = useCallback(async () => {
    try {
      const d = await api.listPlans();
      setPlans(d.plans);
    } catch {}
  }, []);

  useEffect(() => { refreshPlans(); }, [refreshPlans]);

  useEffect(() => {
    const handler = () => refreshPlans();
    window.addEventListener('plan-restored', handler);
    return () => window.removeEventListener('plan-restored', handler);
  }, [refreshPlans]);

  const refreshPlan = useCallback(async (planId) => {
    if (!planId) { setCurrentPlan(null); return; }
    try {
      const d = await api.getPlan(planId);
      setCurrentPlan(d.plan);
    } catch {
      setCurrentPlan(null);
    }
  }, []);

  return (
    <PlanContext.Provider value={{ plans, setPlans, currentPlan, setCurrentPlan, refreshPlans, refreshPlan }}>
      {children}
    </PlanContext.Provider>
  );
}

export function usePlan() {
  const ctx = useContext(PlanContext);
  if (!ctx) throw new Error('usePlan must be used within PlanProvider');
  return ctx;
}
