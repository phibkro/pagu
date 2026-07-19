~~~pagu:gate-session version=0
{"at":"2026-01-01T00:00:00.000Z","session":"sample","profile":"worker","subjectAgent":"category","subjectLabel":"worker"}
~~~

~~~pagu:request id=r1 fs-ro=/home/operator/.ssh at=2026-01-01T00:00:01.000Z
{"need":"read SSH credentials","justification":"sample refused request"}
~~~

~~~pagu:request-decision request=r1 verdict=deny tier=refuse at=2026-01-01T00:00:02.000Z
secret floor
~~~

~~~pagu:request id=r2 fs-ro=/srv/share/projects/reference at=2026-01-01T00:00:03.000Z
{"need":"read reference checkout","justification":"sample safe auto scope"}
~~~

~~~pagu:request-decision request=r2 verdict=approve tier=auto at=2026-01-01T00:00:04.000Z scope=session
covered by session auto rule
~~~

~~~pagu:policy-grant id=pg1 request=r2 scope=session fs-ro=/srv/share/projects/reference canonical-fs-ro=/srv/share/projects/reference session=sample authority=authority policy=policy at=2026-01-01T00:00:05.000Z

~~~

~~~pagu:request id=r3 fs-ro=/opt/private at=2026-01-01T00:00:06.000Z
{"need":"read private input","justification":"sample operator denial"}
~~~

~~~pagu:request-decision request=r3 verdict=deny tier=operator at=2026-01-01T00:00:07.000Z
operator denied
~~~
