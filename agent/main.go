package main

import (
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/kardianos/service"
	"github.com/unicentral/agent/internal/config"
	"github.com/unicentral/agent/internal/connection"
)

var version = "0.1.0"
var defaultEnrollmentKey = "a5ecfd6a83c819d63dc94f2c36550b9f1c1dce02e040e0e0"

type program struct {
	conn *connection.Client
}

func (p *program) Start(s service.Service) error {
	go p.run()
	return nil
}

func (p *program) run() {
	p.conn = connection.New(config.Get())
	p.conn.Run()
}

func (p *program) Stop(s service.Service) error {
	if p.conn != nil {
		p.conn.Close()
	}
	return nil
}

func main() {
	configPath := flag.String("config", "", "Path to config file")
	install := flag.Bool("install", false, "Install as system service")
	uninstall := flag.Bool("uninstall", false, "Uninstall system service")
	server := flag.String("server", "", "Server URL for registration")
	token := flag.String("token", "", "Registration token (legacy)")
	enrollmentKey := flag.String("enrollment-key", "", "Enrollment key for auto-registration")
	category := flag.String("category", "", "Machine category: server or client")
	showVersion := flag.Bool("version", false, "Show version")
	flag.Parse()

	if *showVersion {
		fmt.Printf("unicentral-agent v%s\n", version)
		os.Exit(0)
	}

	if *configPath != "" {
		config.LoadFromFile(*configPath)
	} else {
		config.LoadDefault()
	}

	if *server != "" {
		config.Get().Server = *server
	}
	if *token != "" {
		config.Get().Token = *token
	}
	if *enrollmentKey != "" {
		config.Get().EnrollmentKey = *enrollmentKey
	}
	if *category != "" {
		config.Get().Category = *category
	}

	config.Get().AgentVersion = version
	if config.Get().EnrollmentKey == "" {
		config.Get().EnrollmentKey = defaultEnrollmentKey
	}

	svcConfig := &service.Config{
		Name:        "UniCentralAgent",
		DisplayName: "UniCentral Agent",
		Description: "UniCentral remote management agent",
	}

	prg := &program{}
	s, err := service.New(prg, svcConfig)
	if err != nil {
		log.Fatal(err)
	}

	if *install {
		err = s.Install()
		if err != nil {
			log.Fatal("Failed to install service:", err)
		}
		fmt.Println("Service installed successfully")
		config.Save()
		return
	}

	if *uninstall {
		err = s.Uninstall()
		if err != nil {
			log.Fatal("Failed to uninstall service:", err)
		}
		fmt.Println("Service uninstalled successfully")
		return
	}

	err = s.Run()
	if err != nil {
		log.Fatal(err)
	}
}
