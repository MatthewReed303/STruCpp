TEST 'pump runs either motor type through its interface input'
  VAR dol : MotorDol; vsd : MotorVsd; p1 : Pump; p2 : Pump; END_VAR
  p1(Demand := TRUE, Motor := dol);
  p2(Demand := TRUE, Motor := vsd);
  ASSERT_TRUE(p1.Valid);
  ASSERT_TRUE(p1.Run);
  ASSERT_TRUE(p2.Run);
  ASSERT_EQ(vsd.Speed(), 50.0);
END_TEST

TEST 'unassigned interface input is NULL'
  VAR p : Pump; END_VAR
  p(Demand := TRUE);
  ASSERT_FALSE(p.Valid);
  ASSERT_FALSE(p.Run);
END_TEST

TEST 'interface variables compare by instance'
  VAR dol : MotorDol; other : MotorDol; a : I_MOTOR; b : I_MOTOR := dol; END_VAR
  ASSERT_TRUE(a = NULL);
  a := dol;
  ASSERT_TRUE(a = b);
  a := other;
  ASSERT_TRUE(a <> b);
END_TEST

TEST 'derived interface to base, overriding method through it'
  VAR fast : MotorVsdFast; m : I_MOTOR; base : I_MOTOR_BASE; END_VAR
  m := fast;
  base := m;
  ASSERT_EQ(MotorId(m := base), 3);
  ASSERT_EQ(MotorId(m := NULL), -1);
END_TEST

TEST 'array of interface references as an in-out'
  VAR dol : MotorDol; vsd : MotorVsd; st : Station; ms : ARRAY[1..3] OF I_MOTOR; END_VAR
  dol.Start(Speed := 1.0);
  ms[1] := dol;
  ms[3] := vsd;
  st(Motors := ms);
  ASSERT_EQ(st.Running, 1);
  ASSERT_EQ(st.IdSum, 3);
  ASSERT_TRUE(ms[1].IsRunning());
END_TEST

TEST 'assignment attempt'
  VAR dol : MotorDol; vsd : MotorVsd; b : I_MOTOR_BASE; s : I_SPEED; END_VAR
  b := dol;
  s ?= b;
  ASSERT_TRUE(s = NULL);
  b := vsd;
  s ?= b;
  ASSERT_TRUE(s <> NULL);
  s ?= NULL;
  ASSERT_TRUE(s = NULL);
  s ?= vsd;
  ASSERT_EQ(s.Id(), 2);
END_TEST
