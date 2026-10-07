#!/usr/bin/env python3
"""
Bifurcation (Hopf) analysis of the elementary single-reed model on the TMM input impedance by
harmonic balance (Gilbert, Kergomard & Ngoya 1989; Grand, Gilbert & Laloe 1997; Dalmont,
Gilbert & Kergomard 2000). For a prescribed fundamental amplitude A1 (units of p_M) it solves for
gamma = p_mouth/p_M, the playing frequency and harmonics 0..N. gamma rising with A1 near threshold
= direct (soft) Hopf; falling = inverse (hard onset + hysteresis).

    python3 tools/hb_bifurcation.py C5 [G4 ...]    # full impedance vs. without the 2nd-harmonic coupling
"""
# # dimensionless p = p_mp/p_M, gamma = p_mouth/p_M, u = U/U_A, U_A = alpha w H0 sqrt(2 pM/rho)
# u = F(gamma - p),  F(x) = (1 - x) sqrt(x) for 0<=x<=1 (reed closes at x=1), reverse flow for x<0.
import sys; import os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, tmm
from scipy.optimize import fsolve
g=tmm.Geometry(); A=tmm.air(22)
N=10; M=256
pM=6700.; H0=1.03e-3; w=0.0135; rho=1.196
def setup(note, alpha=0.7, zscale=1.0, extra_loss=1.0, reed=True):
    f=next(q for q in g.doc['fingerings'] if q['note']==note)
    op=g.hole_openness(f['keys'])
    UA=alpha*w*H0*np.sqrt(2*pM/rho)
    fr=np.linspace(1,6000,12000)
    if not reed: g.reed_volume_save=g.reed_volume; 
    Z=tmm.input_impedance(g,fr,op,A,include_reed=reed)
    if extra_loss!=1.0:
        # crude: scale the resonant part (Z/(1+..)) -- approximate by reducing peak heights: Z -> Z/(1+(extra-1)*|Z|/Zmax)
        pass
    Zt=Z*UA/pM*zscale
    return f['f_target'], (lambda fq: np.interp(fq,fr,Zt.real)+1j*np.interp(fq,fr,Zt.imag))
def F(x, mod):
    xc=np.clip(x,-5,1)
    base=np.where(x>=0,(1-xc)*np.sqrt(np.abs(xc)),-(1-xc)*np.sqrt(np.abs(xc)))
    base=np.where(x>1,0.0,base)
    return base*mod(x) if mod else base
def resid(v, A1, Zf, mod):
    gam,om,p0=v[0],v[1],v[2]
    P=np.zeros(N+1,complex); P[0]=p0; P[1]=A1
    for k in range(2,N+1): P[k]=v[3+2*(k-2)]+1j*v[4+2*(k-2)]
    t=np.arange(M)/M
    p=np.real(sum(P[k]*np.exp(2j*np.pi*k*t)*(1 if k==0 else 2) for k in range(N+1)))*1.0
    u=F(gam-p,mod)
    U=np.fft.fft(u)/M
    r=[]
    Zk=[Zf(k*om) if k>0 else Zf(1e-3)+0j for k in range(N+1)]
    e0=P[0].real-Zk[0].real*U[0].real; r.append(e0)
    for k in range(1,N+1):
        e=P[k]-Zk[k]*U[k]; r+= [e.real,e.imag]
    return np.array(r)
def branch(note, amps, mod=None, **kw):
    f0,Zf=setup(note,**kw)
    v=np.zeros(3+2*(N-1)); v[0]=0.33; v[1]=f0; v[2]=0
    out=[]
    for a in amps:
        sol,info,ier,msg=fsolve(resid,v,args=(a,Zf,mod),full_output=True)
        ok=ier==1 and np.max(np.abs(info['fvec']))<1e-6
        if ok: v=sol
        out.append((a,sol[0],sol[1],ok))
    return out

if __name__ == "__main__":
    amps = [0.003, 0.01, 0.03, 0.06, 0.1, 0.15, 0.2]
    for note in sys.argv[1:] or ["C5"]:
        f0, Zf = setup(note)
        def run(Zm, label):
            v = np.zeros(3 + 2 * (N - 1)); v[0] = 0.33; v[1] = f0
            gs = []
            for a in amps:
                sol, info, ier, msg = fsolve(resid, v, args=(a, Zm, None), full_output=True)
                ok = ier == 1 and np.max(np.abs(info["fvec"])) < 1e-6
                if ok:
                    v = sol
                gs.append(f"{sol[0]:.4f}{'' if ok else '?'}")
            print(f"{note:4s} {label:34s} gamma at A1={amps}: {' '.join(gs)}")
        run(Zf, "full impedance")
        run(lambda f: Zf(f) if (f < 1.5 * f0 or f > 2.5 * f0) else 0j, "Z(2w) removed")
        run(lambda f: Zf(f) if (f < 1.5 * f0 or f > 2.5 * f0) else np.conj(Zf(f)), "Z(2w) mirrored (2nd peak sharp)")
